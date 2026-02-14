import React, { useState, useEffect, useRef } from 'react';
import mqtt from 'mqtt';
import { Room, RoomEvent, VideoPresets, Track, LocalTrackPublication } from 'livekit-client';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { 
  ACTION_MAPPING, 
  DEFAULT_MQTT_BROKER, 
  DEFAULT_CLIENT_ID, 
  TOOLS, 
  SYSTEM_INSTRUCTION 
} from './constants';
import { AppConfig, ConnectionState, LogEntry } from './types';
import { createPcmBlob, base64ToFloat32Array } from './utils/audio';
import { generateLiveKitToken } from './utils/token';
import SettingsModal from './components/SettingsModal';
import LampVisualizer from './components/LampVisualizer';

export default function App() {
  // State
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLightOn, setIsLightOn] = useState(false);
  const [lastAction, setLastAction] = useState('idle');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(1);
  const [videoRef, setVideoRef] = useState<HTMLVideoElement | null>(null);

  // Refs
  const mqttClientRef = useRef<mqtt.MqttClient | null>(null);
  const livekitRoomRef = useRef<Room | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  
  // Helper to add logs
  const addLog = (message: string, source: LogEntry['source'], type: LogEntry['type'] = 'info') => {
    setLogs(prev => [{
      id: Math.random().toString(36).substring(7),
      timestamp: new Date(),
      source,
      message,
      type
    }, ...prev].slice(0, 50));
  };

  // 1. Initialize MQTT
  const connectToMqtt = async (topic: string) => {
    return new Promise<void>((resolve, reject) => {
      addLog(`Connecting to MQTT Broker...`, 'System', 'info');
      
      const client = mqtt.connect(DEFAULT_MQTT_BROKER, {
        clientId: DEFAULT_CLIENT_ID,
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 1000,
      });

      client.on('connect', () => {
        addLog('MQTT Connected', 'MQTT', 'success');
        client.publish(topic, 'hello'); // Wake up lamp
        mqttClientRef.current = client;
        resolve();
      });

      client.on('error', (err) => {
        addLog(`MQTT Error: ${err.message}`, 'MQTT', 'error');
        reject(err);
      });
    });
  };

  // 2. Publish to MQTT
  const publishAction = (action: string) => {
    if (!mqttClientRef.current || !config) return;
    
    // Convert generic action name to ESP32 command using map
    const esp32Command = ACTION_MAPPING[action] || action;
    
    mqttClientRef.current.publish(config.mqttTopic, esp32Command);
    addLog(`Sent command: "${esp32Command}"`, 'MQTT', 'info');
    setLastAction(action);
    
    if (action === 'turn_light_on' || esp32Command === 'on') setIsLightOn(true);
    if (action === 'turn_light_off' || esp32Command === 'off') setIsLightOn(false);
  };

  // 3. Connect to LiveKit (Optional)
  const connectToLiveKit = async (cfg: AppConfig) => {
    if (!cfg.livekitUrl || !cfg.livekitApiKey || !cfg.livekitApiSecret) {
      addLog('LiveKit skipped (Missing credentials)', 'LiveKit', 'info');
      return null;
    }

    try {
      addLog('Connecting to LiveKit Room...', 'LiveKit', 'info');
      const token = await generateLiveKitToken(cfg.livekitApiKey, cfg.livekitApiSecret, "Web-Controller", "room-01");
      
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });

      await room.connect(cfg.livekitUrl, token);
      addLog(`Joined Room: ${room.name}`, 'LiveKit', 'success');

      // Publish Camera and Mic
      await room.localParticipant.enableCameraAndMicrophone();
      addLog('Published Camera & Mic to Room', 'LiveKit', 'success');
      
      // Attach local video to UI
      const tracks = room.localParticipant.videoTracks;
      if (tracks.size > 0 && videoRef) {
         const trackPub = Array.from(tracks.values())[0] as LocalTrackPublication;
         trackPub.track?.attach(videoRef);
      }

      livekitRoomRef.current = room;
      return room;
    } catch (e: any) {
      addLog(`LiveKit Connection Failed: ${e.message}`, 'LiveKit', 'error');
      // Don't fail the whole app if LiveKit fails, just log it
      return null;
    }
  };

  // 4. Start Session (The Main Logic)
  const startSession = async (currentConfig: AppConfig) => {
    try {
      setConnectionState(ConnectionState.CONNECTING);
      
      // A. MQTT Connection
      await connectToMqtt(currentConfig.mqttTopic);

      // B. LiveKit Connection (Parallel)
      await connectToLiveKit(currentConfig);

      // C. Audio Context Setup for Gemini
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000 
      });
      
      // Output Audio Chain (Gemini -> Speakers)
      outputNodeRef.current = audioContextRef.current.createGain();
      outputNodeRef.current.gain.value = volume;
      outputNodeRef.current.connect(audioContextRef.current.destination);
      
      // Input Audio Setup (Mic -> Gemini)
      // We grab a new stream for Gemini to ensure clean processing independent of LiveKit
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        } 
      });
      
      const inputContext = new AudioContext({ sampleRate: 16000 });
      const source = inputContext.createMediaStreamSource(stream);
      processorRef.current = inputContext.createScriptProcessor(4096, 1, 1);
      
      source.connect(processorRef.current);
      processorRef.current.connect(inputContext.destination);

      // D. Gemini Client
      const ai = new GoogleGenAI({ apiKey: currentConfig.googleApiKey });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          tools: TOOLS,
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } }
          }
        },
        callbacks: {
          onopen: () => {
            addLog('Connected to Gemini Brain', 'System', 'success');
            setConnectionState(ConnectionState.CONNECTED);
            
            // Start processing Mic input
            if(processorRef.current) {
               processorRef.current.onaudioprocess = (e) => {
                  const inputData = e.inputBuffer.getChannelData(0);
                  const pcmBlob = createPcmBlob(inputData);
                  
                  sessionPromise.then(session => {
                     session.sendRealtimeInput({ media: pcmBlob });
                  });
               };
            }
          },
          onmessage: async (msg: LiveServerMessage) => {
            // 1. Handle Tool Calls
            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                addLog(`Function: ${fc.name}`, 'AI', 'info');
                let result = { result: "ok" };

                if (fc.name === 'play_recording') {
                   const recName = (fc.args as any).recording_name;
                   publishAction(recName);
                   result = { result: `Executed action ${recName}` };
                } else if (fc.name === 'turn_light_on') {
                   publishAction('light_on');
                } else if (fc.name === 'turn_light_off') {
                   publishAction('light_off');
                } else if (fc.name === 'stop_movement') {
                   publishAction('stop');
                }

                sessionPromise.then(session => {
                  session.sendToolResponse({
                    functionResponses: {
                      id: fc.id,
                      name: fc.name,
                      response: result
                    }
                  });
                });
              }
            }

            // 2. Handle Audio Output
            const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && audioContextRef.current && outputNodeRef.current) {
               setIsSpeaking(true);
               const float32 = base64ToFloat32Array(audioData);
               
               const audioBuffer = audioContextRef.current.createBuffer(1, float32.length, 24000);
               audioBuffer.getChannelData(0).set(float32);
               
               const source = audioContextRef.current.createBufferSource();
               source.buffer = audioBuffer;
               source.connect(outputNodeRef.current);
               
               const currentTime = audioContextRef.current.currentTime;
               if (nextStartTimeRef.current < currentTime) {
                 nextStartTimeRef.current = currentTime;
               }
               
               source.start(nextStartTimeRef.current);
               nextStartTimeRef.current += audioBuffer.duration;
               
               source.onended = () => {
                 if (audioContextRef.current && audioContextRef.current.currentTime >= nextStartTimeRef.current) {
                    setIsSpeaking(false);
                 }
               };
            }
          },
          onclose: () => {
            addLog('Gemini Disconnected', 'System', 'error');
            setConnectionState(ConnectionState.DISCONNECTED);
          },
          onerror: (err) => {
            addLog(`Gemini Error: ${err.message}`, 'System', 'error');
          }
        }
      });

    } catch (e: any) {
      addLog(`Setup Error: ${e.message}`, 'System', 'error');
      setConnectionState(ConnectionState.ERROR);
    }
  };

  const handleConnect = (newConfig: AppConfig) => {
    setConfig(newConfig);
    startSession(newConfig);
  };
  
  const disconnect = () => {
     if(mqttClientRef.current) mqttClientRef.current.end();
     if(livekitRoomRef.current) livekitRoomRef.current.disconnect();
     if(audioContextRef.current) audioContextRef.current.close();
     if(processorRef.current) processorRef.current.disconnect();
     setConnectionState(ConnectionState.DISCONNECTED);
     window.location.reload(); 
  };

  // Effect to attach video element when ready
  useEffect(() => {
    if (livekitRoomRef.current && videoRef) {
       const tracks = livekitRoomRef.current.localParticipant.videoTracks;
       if (tracks.size > 0) {
          const trackPub = Array.from(tracks.values())[0] as LocalTrackPublication;
          trackPub.track?.attach(videoRef);
       }
    }
  }, [videoRef, connectionState]);

  return (
    <div className="min-h-screen flex flex-col items-center p-6 relative overflow-hidden font-sans">
      {/* Background */}
      <div className="absolute top-0 left-0 w-full h-full bg-[#0f172a] -z-20" />
      <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_center,_rgba(30,41,59,0.8)_0%,_rgba(15,23,42,1)_100%)] -z-10" />

      <SettingsModal onConnect={handleConnect} connectionState={connectionState} />

      {/* Header */}
      <header className="w-full max-w-5xl flex justify-between items-center mb-6 pb-4 border-b border-slate-800/50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20">
             <span className="text-xl">💡</span>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">SparkLamp</h1>
            <p className="text-xs text-slate-400">LiveKit + Gemini Controller</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
            connectionState === ConnectionState.CONNECTED 
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' 
              : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${connectionState === ConnectionState.CONNECTED ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
            {connectionState}
          </div>
          {connectionState === ConnectionState.CONNECTED && (
             <button onClick={disconnect} className="text-xs bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-lg transition border border-slate-700">
               Disconnect
             </button>
          )}
        </div>
      </header>

      {/* Dashboard Grid */}
      <main className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-6 flex-grow h-[calc(100vh-140px)]">
        
        {/* Left Column: Visualizer & Controls (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          {/* Main Card */}
          <div className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800 relative overflow-hidden flex-grow flex flex-col justify-center items-center shadow-2xl">
             <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-slate-700 to-transparent opacity-50" />
             
             <LampVisualizer lastAction={lastAction} isLightOn={isLightOn} isSpeaking={isSpeaking} />
             
             {/* LiveKit Video Preview (Picture in Picture style) */}
             {config?.livekitUrl && (
               <div className="absolute top-4 right-4 w-24 h-24 bg-black rounded-lg overflow-hidden border border-slate-700 shadow-lg">
                  <video 
                    ref={setVideoRef} 
                    className="w-full h-full object-cover transform -scale-x-100" 
                    autoPlay 
                    muted 
                    playsInline 
                  />
                  <div className="absolute bottom-0 inset-x-0 bg-black/60 text-[8px] text-white text-center py-0.5">
                    LiveKit Cam
                  </div>
               </div>
             )}
          </div>

          {/* Controls */}
          <div className="grid grid-cols-3 gap-3">
             {[
               { cmd: 'wake_up', label: 'Wake Up', color: 'bg-slate-800' },
               { cmd: 'nod', label: 'Nod', color: 'bg-slate-800' },
               { cmd: 'headshake', label: 'Shake', color: 'bg-slate-800' },
               { cmd: 'happy_wiggle', label: 'Happy', color: 'bg-slate-800' },
               { cmd: 'think', label: 'Think', color: 'bg-slate-800' },
               { cmd: 'turn_light_on', label: 'Light', color: 'bg-amber-500/20 text-amber-300 border-amber-500/30' }
             ].map((btn) => (
               <button 
                 key={btn.cmd}
                 onClick={() => publishAction(btn.cmd)} 
                 className={`p-3 rounded-xl text-xs font-semibold border border-slate-700/50 hover:bg-white/5 active:scale-95 transition-all ${btn.color}`}
               >
                 {btn.label}
               </button>
             ))}
          </div>
        </div>

        {/* Right Column: Logs & Metrics (7 cols) */}
        <div className="lg:col-span-7 flex flex-col gap-6 h-full overflow-hidden">
          <div className="flex-grow bg-black/30 rounded-2xl border border-slate-800 overflow-hidden flex flex-col">
            <div className="bg-slate-900/90 px-4 py-3 border-b border-slate-800 flex justify-between items-center">
               <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">System Activity</span>
               <div className="flex gap-2">
                 <div className="w-2 h-2 rounded-full bg-slate-700" title="Audio"></div>
                 <div className="w-2 h-2 rounded-full bg-slate-700" title="MQTT"></div>
               </div>
            </div>
            
            <div className="flex-grow overflow-y-auto p-4 space-y-3 font-mono text-xs scrollbar-thin scrollbar-thumb-slate-700">
              {logs.length === 0 && (
                 <div className="h-full flex flex-col items-center justify-center text-slate-600 opacity-50">
                    <span className="text-4xl mb-2">⌨️</span>
                    <p>Ready to connect...</p>
                 </div>
              )}
              {logs.map(log => (
                <div key={log.id} className="flex gap-3 animate-fadeIn group">
                  <span className="text-slate-600 shrink-0 select-none">
                    {log.timestamp.toLocaleTimeString([], {hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit'})}
                  </span>
                  <div className="flex-grow break-all">
                    <span className={`font-bold mr-2 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${
                      log.source === 'User' ? 'bg-blue-500/10 text-blue-400' :
                      log.source === 'AI' ? 'bg-purple-500/10 text-purple-400' :
                      log.source === 'MQTT' ? 'bg-orange-500/10 text-orange-400' : 
                      log.source === 'LiveKit' ? 'bg-pink-500/10 text-pink-400' :
                      'bg-slate-700/30 text-slate-400'
                    }`}>
                      {log.source}
                    </span>
                    <span className={`${
                      log.type === 'error' ? 'text-rose-400' :
                      log.type === 'success' ? 'text-emerald-400' : 'text-slate-300'
                    }`}>
                      {log.message}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Status Footer */}
            <div className="bg-slate-900/90 border-t border-slate-800 p-3 flex items-center justify-between gap-4">
               <div className="flex items-center gap-3">
                  <span className={`text-[10px] uppercase tracking-wider font-bold ${config?.livekitUrl ? 'text-pink-400' : 'text-slate-600'}`}>
                    {config?.livekitUrl ? '• LiveKit Active' : '• LiveKit Inactive'}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider font-bold text-orange-400">
                    • MQTT Active
                  </span>
               </div>
               
               <div className="flex items-center gap-3">
                   <span className="text-xs text-slate-400 font-medium">Volume</span>
                   <input 
                     type="range" 
                     min="0" 
                     max="1" 
                     step="0.01" 
                     value={volume}
                     onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        setVolume(v);
                        if(outputNodeRef.current) outputNodeRef.current.gain.value = v;
                     }}
                     className="w-24 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                   />
               </div>
            </div>
          </div>
        </div>

      </main>
    </div>
  );
}