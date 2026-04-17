import React, { useState, useEffect, useRef } from 'react';
import mqtt from 'mqtt';
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
import SettingsModal from './components/SettingsModal';
import LampVisualizer from './components/LampVisualizer';

// Helper for image resizing/compression
const processImageForGemini = async (blob: Blob): Promise<string> => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64data = reader.result as string;
      // Remove data URL prefix (data:image/jpeg;base64,)
      resolve(base64data.split(',')[1]);
    };
    reader.readAsDataURL(blob);
  });
};

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
  
  // New State for Features
  const [isVideoEnabled, setIsVideoEnabled] = useState(false); // Toggle for AI Vision
  const [activeTab, setActiveTab] = useState<'chat' | 'logs'>('chat');
  const [chatInput, setChatInput] = useState('');

  // Refs
  const configRef = useRef<AppConfig | null>(null);
  const mqttClientRef = useRef<mqtt.MqttClient | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sessionRef = useRef<any>(null);
  const isSessionActive = useRef(false);
  const isWebSocketOpen = useRef(false); // New flag to track WebSocket state
  const videoCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const videoIntervalRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

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

  // --- VISION LOGIC ---
  const sendVideoFrame = async () => {
    if (!videoRef || !sessionRef.current || !isVideoEnabled || !isSessionActive.current || !isWebSocketOpen.current) return;
    
    const canvas = videoCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size to match video (or scaled down for performance)
    const scale = 0.5; // Scale down to 50% to save bandwidth
    canvas.width = videoRef.videoWidth * scale;
    canvas.height = videoRef.videoHeight * scale;

    ctx.drawImage(videoRef, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(async (blob) => {
      if (blob && isSessionActive.current) {
        try {
          const base64Data = await processImageForGemini(blob);
          if (sessionRef.current && isSessionActive.current) {
            sessionRef.current.sendRealtimeInput({
              media: {
                mimeType: 'image/jpeg',
                data: base64Data
              }
            });
          }
        } catch (e) {
          console.error("Failed to send video frame", e);
        }
      }
    }, 'image/jpeg', 0.6); // 60% quality
  };

  // Toggle Video Loop
  useEffect(() => {
    if (isVideoEnabled && connectionState === ConnectionState.CONNECTED) {
      addLog('AI Vision Enabled - Streaming Video', 'System', 'success');
      // Send frames at 1 FPS (adjust as needed)
      videoIntervalRef.current = window.setInterval(sendVideoFrame, 1000);
    } else {
      if (videoIntervalRef.current) {
        clearInterval(videoIntervalRef.current);
        videoIntervalRef.current = null;
      }
    }
    return () => {
      if (videoIntervalRef.current) clearInterval(videoIntervalRef.current);
    };
  }, [isVideoEnabled, connectionState]);

  // --- CHAT & UPLOAD LOGIC ---
  const handleSendMessage = () => {
    if (!chatInput.trim() || !sessionRef.current || !isSessionActive.current || !isWebSocketOpen.current) return;
    try {
      sessionRef.current.sendClientContent({ turns: chatInput, turnComplete: true });
      addLog(chatInput, 'User', 'info');
      setChatInput('');
    } catch (e) {
      addLog("Failed to send message", 'System', 'error');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !sessionRef.current || !isSessionActive.current || !isWebSocketOpen.current) return;

    addLog(`Uploading image: ${file.name}...`, 'System', 'info');

    // Convert file to base64
    const reader = new FileReader();
    reader.onload = () => {
        const base64String = (reader.result as string).split(',')[1];
        
        if (isSessionActive.current) {
          try {
            sessionRef.current.sendRealtimeInput({
                media: {
                    mimeType: file.type,
                    data: base64String
                }
            });
            addLog(`Image sent to AI`, 'User', 'success');
          } catch (e) {
            console.error("Upload failed", e);
          }
        }
    };
    reader.readAsDataURL(file);
    
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSnapshot = () => {
      if (!videoRef || !sessionRef.current || !isSessionActive.current || !isWebSocketOpen.current) {
          addLog("Camera not ready", "System", "error");
          return;
      }
      
      const canvas = videoCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      canvas.width = videoRef.videoWidth;
      canvas.height = videoRef.videoHeight;
      ctx.drawImage(videoRef, 0, 0);
      
      canvas.toBlob(async (blob) => {
          if (blob && isSessionActive.current) {
              try {
                const base64Data = await processImageForGemini(blob);
                if (sessionRef.current && isSessionActive.current) {
                  sessionRef.current.sendRealtimeInput({
                      media: { mimeType: 'image/jpeg', data: base64Data }
                  });
                  addLog("Snapshot sent to AI", "User", "success");
                }
              } catch (e) {
                 console.error("Snapshot failed", e);
              }
          }
      }, 'image/jpeg', 0.8);
  };

  // --- EXISTING CONNECT LOGIC ---
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
        client.publish(topic, 'hello');
        mqttClientRef.current = client;
        resolve();
      });
      client.on('error', (err) => {
        addLog(`MQTT Error: ${err.message}`, 'MQTT', 'error');
        reject(err);
      });
    });
  };

  const publishAction = (action: string) => {
    if (!mqttClientRef.current || !configRef.current) {
      if (!configRef.current) console.warn("Cannot publish: Config is missing");
      return;
    }
    const esp32Command = ACTION_MAPPING[action] || action;
    mqttClientRef.current.publish(configRef.current.mqttTopic, esp32Command);
    addLog(`Sent command: "${esp32Command}"`, 'MQTT', 'info');
    setLastAction(action);
    if (action === 'turn_light_on' || esp32Command === 'on') setIsLightOn(true);
    if (action === 'turn_light_off' || esp32Command === 'off') setIsLightOn(false);
  };

  const connectToLiveKit = async (cfg: AppConfig) => {
    // LiveKit removed - using browser camera directly
    if (!videoRef) return;
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      localStreamRef.current = stream;
      videoRef.srcObject = stream;
      addLog('Camera enabled', 'System', 'success');
    } catch (e: any) {
      addLog(`Camera access failed: ${e.message}`, 'System', 'error');
    }
  };

  const startSession = async (currentConfig: AppConfig) => {
    try {
      setConnectionState(ConnectionState.CONNECTING);
      
      isSessionActive.current = false;
      isWebSocketOpen.current = false; // Reset WebSocket flag
      
      await connectToMqtt(currentConfig.mqttTopic);
      await connectToLiveKit(currentConfig);

      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      outputNodeRef.current = audioContextRef.current.createGain();
      outputNodeRef.current.gain.value = volume;
      outputNodeRef.current.connect(audioContextRef.current.destination);
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 } 
      });
      const inputContext = new AudioContext({ sampleRate: 16000 });
      const source = inputContext.createMediaStreamSource(stream);
      processorRef.current = inputContext.createScriptProcessor(4096, 1, 1);
      source.connect(processorRef.current);
      processorRef.current.connect(inputContext.destination);

      const ai = new GoogleGenAI({ apiKey: currentConfig.googleApiKey });
      const sessionPromise = ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config: {
          tools: TOOLS,
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } }
        },
        callbacks: {
          onopen: async () => {
            addLog('Connected to Gemini', 'System', 'success');
            setConnectionState(ConnectionState.CONNECTED);
            isSessionActive.current = true;
            isWebSocketOpen.current = true;
            
            // Wait for session promise to resolve
            try {
              const session = await sessionPromise;
              sessionRef.current = session;
              
              // Now set up audio processor
              if(processorRef.current && isSessionActive.current) {
                processorRef.current.onaudioprocess = (e) => {
                  if (!isSessionActive.current || !sessionRef.current || !isWebSocketOpen.current) return;
                  const inputData = e.inputBuffer.getChannelData(0);
                  const pcmBlob = createPcmBlob(inputData);
                  try { sessionRef.current.sendRealtimeInput({ media: pcmBlob }); } catch(err) {}
                };
              }
            } catch(e) {
              addLog('Failed to initialize session', 'System', 'error');
            }
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.toolCall && msg.toolCall.functionCalls) {
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
                } else if (fc.name === 'reset_to_idle') {
                   publishAction('release');
                   result = { result: "Servos released to idle state" };
                }
                
                if (isSessionActive.current && sessionRef.current) {
                  try { sessionRef.current.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: result } }); } catch(e) {}
                }
              }
            }
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
               if (nextStartTimeRef.current < currentTime) nextStartTimeRef.current = currentTime;
               source.start(nextStartTimeRef.current);
               nextStartTimeRef.current += audioBuffer.duration;
               source.onended = () => {
                 if (audioContextRef.current && audioContextRef.current.currentTime >= nextStartTimeRef.current) {
                    setIsSpeaking(false);
                 }
               };
            }
            
            // Handle Text output from model (if any) for Chat UI
            const textData = msg.serverContent?.modelTurn?.parts?.find(p => p.text)?.text;
            if (textData) {
                addLog(textData, 'AI', 'info');
            }
          },
          onclose: () => {
            isSessionActive.current = false;
            isWebSocketOpen.current = false; // Mark WebSocket as closed
            
            if (processorRef.current) {
                processorRef.current.disconnect();
                processorRef.current.onaudioprocess = null;
            }
            
            addLog('Gemini Disconnected', 'System', 'error');
            setConnectionState(ConnectionState.DISCONNECTED);
            sessionRef.current = null;
          },
          onerror: (err) => {
            isSessionActive.current = false;
            addLog(`Gemini Error: ${err.message}`, 'System', 'error');
          }
        }
      });
      
      // Session will be set in onopen callback
      await sessionPromise; // Just wait for it to complete
    } catch (e: any) {
      isSessionActive.current = false;
      addLog(`Setup Error: ${e.message}`, 'System', 'error');
      setConnectionState(ConnectionState.ERROR);
    }
  };

  const handleConnect = (newConfig: AppConfig) => {
    setConfig(newConfig);
    configRef.current = newConfig; 
    startSession(newConfig);
  };
  
  const disconnect = () => {
     isSessionActive.current = false;
     
     if(mqttClientRef.current) mqttClientRef.current.end();
     if(localStreamRef.current) {
       localStreamRef.current.getTracks().forEach(track => track.stop());
     }
     if(audioContextRef.current) audioContextRef.current.close();
     
     if(processorRef.current) {
        processorRef.current.disconnect();
        processorRef.current.onaudioprocess = null;
     }
     
     setConnectionState(ConnectionState.DISCONNECTED);
     sessionRef.current = null;
     window.location.reload(); 
  };

  useEffect(() => {
    return () => {
      if(localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  return (
    <div className="min-h-screen flex flex-col items-center p-6 relative overflow-hidden font-sans">
      <div className="absolute top-0 left-0 w-full h-full bg-[#0f172a] -z-20" />
      <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_center,_rgba(30,41,59,0.8)_0%,_rgba(15,23,42,1)_100%)] -z-10" />

      <SettingsModal onConnect={handleConnect} connectionState={connectionState} />

      <header className="w-full max-w-5xl flex justify-between items-center mb-6 pb-4 border-b border-slate-800/50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20">
             <span className="text-xl">💡</span>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">SparkLamp</h1>
            <p className="text-xs text-slate-400">Gemini Live API Controller</p>
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

      <main className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-6 flex-grow h-[calc(100vh-140px)]">
        
        {/* Left Column: Visualizer & Controls */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          <div className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800 relative overflow-hidden flex-grow flex flex-col justify-center items-center shadow-2xl">
             <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-slate-700 to-transparent opacity-50" />
             <LampVisualizer lastAction={lastAction} isLightOn={isLightOn} isSpeaking={isSpeaking} />
             
             {/* Video Feed & Vision Controls */}
             <div className="absolute top-4 right-4 flex flex-col items-end gap-2">
                 <div className="w-32 h-24 bg-black rounded-lg overflow-hidden border border-slate-700 shadow-lg relative group">
                    <video 
                      ref={setVideoRef} 
                      className="w-full h-full object-cover transform -scale-x-100" 
                      autoPlay 
                      muted 
                      playsInline 
                    />
                    <div className="absolute bottom-0 inset-x-0 bg-black/60 text-[8px] text-white text-center py-0.5">
                      {isVideoEnabled ? '👁️ AI Watching' : '🙈 Vision Off'}
                    </div>
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                       <button 
                         onClick={handleSnapshot}
                         className="bg-white/20 hover:bg-white/40 p-1.5 rounded-full backdrop-blur-sm"
                         title="Take Snapshot"
                       >
                          📷
                       </button>
                    </div>
                 </div>
                 
                 <button 
                   onClick={() => setIsVideoEnabled(!isVideoEnabled)}
                   className={`text-[10px] px-2 py-1 rounded-full border transition-all ${
                       isVideoEnabled 
                       ? 'bg-purple-500/20 text-purple-300 border-purple-500/50 animate-pulse' 
                       : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'
                   }`}
                 >
                   {isVideoEnabled ? 'Stop Broadcasting' : 'Broadcast Video to AI'}
                 </button>
             </div>
          </div>

          <div className="grid grid-cols-4 gap-2">
             {[
               { cmd: 'wake_up', label: 'Wake', color: 'bg-slate-800' },
               { cmd: 'nod', label: 'Nod', color: 'bg-slate-800' },
               { cmd: 'headshake', label: 'Shake', color: 'bg-slate-800' },
               { cmd: 'happy_wiggle', label: 'Happy', color: 'bg-slate-800' },
               { cmd: 'think', label: 'Think', color: 'bg-slate-800' },
               { cmd: 'scanning', label: 'Scan', color: 'bg-slate-800' },
               { cmd: 'shy', label: 'Shy', color: 'bg-slate-800' },
               { cmd: 'sad', label: 'Sad', color: 'bg-slate-800' },
               { cmd: 'shock', label: 'Shock', color: 'bg-slate-800' },
               { cmd: 'release', label: 'Relax', color: 'bg-slate-800' },
               { cmd: 'turn_light_on', label: 'Light On', color: 'bg-amber-500/20 text-amber-300 border-amber-500/30 col-span-2' },
               { cmd: 'turn_light_off', label: 'Light Off', color: 'bg-slate-800/50 text-slate-400 border-slate-700 col-span-2' }
             ].map((btn) => (
               <button 
                 key={btn.cmd}
                 onClick={() => publishAction(btn.cmd)} 
                 className={`p-2 rounded-xl text-[10px] font-semibold border border-slate-700/50 hover:bg-white/5 active:scale-95 transition-all flex items-center justify-center ${btn.color}`}
               >
                 {btn.label}
               </button>
             ))}
          </div>
        </div>

        {/* Right Column: Chat & Logs */}
        <div className="lg:col-span-7 flex flex-col gap-6 h-full overflow-hidden">
          <div className="flex-grow bg-black/30 rounded-2xl border border-slate-800 overflow-hidden flex flex-col">
            
            {/* Tabs */}
            <div className="bg-slate-900/90 border-b border-slate-800 flex">
               <button 
                 onClick={() => setActiveTab('chat')}
                 className={`flex-1 py-3 text-xs font-semibold uppercase tracking-wider transition-colors ${activeTab === 'chat' ? 'bg-slate-800 text-blue-400 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}
               >
                 Chat & Context
               </button>
               <button 
                 onClick={() => setActiveTab('logs')}
                 className={`flex-1 py-3 text-xs font-semibold uppercase tracking-wider transition-colors ${activeTab === 'logs' ? 'bg-slate-800 text-orange-400 border-b-2 border-orange-500' : 'text-slate-500 hover:text-slate-300'}`}
               >
                 System Logs
               </button>
            </div>
            
            {/* Content Area */}
            <div className="flex-grow overflow-y-auto p-4 space-y-3 font-mono text-xs scrollbar-thin scrollbar-thumb-slate-700 relative">
              {logs.length === 0 && (
                 <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600 opacity-50 pointer-events-none">
                    <span className="text-4xl mb-2">💬</span>
                    <p>Start the agent to chat...</p>
                 </div>
              )}
              
              {/* Filter logs based on tab */}
              {logs.filter(l => activeTab === 'logs' ? true : (l.source === 'User' || l.source === 'AI')).map(log => (
                <div key={log.id} className={`flex gap-3 animate-fadeIn group ${log.source === 'User' ? 'flex-row-reverse' : ''}`}>
                   {activeTab === 'logs' && (
                       <span className="text-slate-600 shrink-0 select-none text-[10px] self-center">
                        {log.timestamp.toLocaleTimeString([], {hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit'})}
                       </span>
                   )}
                  <div className={`max-w-[80%] rounded-xl p-3 ${
                      log.source === 'User' ? 'bg-blue-600/20 border border-blue-500/30 text-blue-100' :
                      log.source === 'AI' ? 'bg-slate-800 border border-slate-700 text-slate-200' :
                      'text-slate-400'
                  }`}>
                    {activeTab === 'logs' && (
                        <div className={`font-bold text-[8px] uppercase tracking-wider mb-1 opacity-70 ${
                            log.source === 'User' ? 'text-right' : 'text-left'
                        }`}>
                            {log.source}
                        </div>
                    )}
                    <div className="whitespace-pre-wrap">{log.message}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Input Area (Only for Chat Tab) */}
            {activeTab === 'chat' && connectionState === ConnectionState.CONNECTED && (
                <div className="bg-slate-900/90 border-t border-slate-800 p-3">
                    <div className="flex gap-2">
                        {/* File Upload */}
                        <button 
                            onClick={() => fileInputRef.current?.click()}
                            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-700 transition"
                            title="Upload Image/Context"
                        >
                            📎
                        </button>
                        <input 
                            type="file" 
                            ref={fileInputRef} 
                            className="hidden" 
                            accept="image/*"
                            onChange={handleFileUpload}
                        />

                        {/* Snapshot Shortut */}
                        <button 
                            onClick={handleSnapshot}
                            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-700 transition"
                            title="Send Camera Snapshot"
                        >
                            📷
                        </button>
                        
                        {/* Text Input */}
                        <input 
                            type="text"
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                            placeholder="Type a message to AI..."
                            className="flex-grow bg-black/50 border border-slate-700 rounded-lg px-3 text-white focus:outline-none focus:border-blue-500"
                        />
                        
                        <button 
                            onClick={handleSendMessage}
                            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-semibold transition"
                        >
                            Send
                        </button>
                    </div>
                </div>
            )}

            {/* Status Footer (Volume) */}
            {activeTab === 'logs' && (
                <div className="bg-slate-900/90 border-t border-slate-800 p-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
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
            )}
          </div>
        </div>

      </main>
    </div>
  );
}