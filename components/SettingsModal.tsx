import React, { useState, useEffect } from 'react';
import { AppConfig, ConnectionState } from '../types';
import { DEFAULT_MQTT_TOPIC, DEFAULT_MQTT_BROKER } from '../constants';

interface SettingsModalProps {
  onConnect: (config: AppConfig) => void;
  connectionState: ConnectionState;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ onConnect, connectionState }) => {
  // Config State
  const [googleKey, setGoogleKey] = useState('');
  const [livekitUrl, setLivekitUrl] = useState('');
  const [livekitKey, setLivekitKey] = useState('');
  const [livekitSecret, setLivekitSecret] = useState('');
  
  // MQTT Settings
  const [mqttBroker, setMqttBroker] = useState(DEFAULT_MQTT_BROKER);
  const [mqttTopic, setMqttTopic] = useState(DEFAULT_MQTT_TOPIC);
  
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [protocolWarning, setProtocolWarning] = useState<string | null>(null);

  // Load from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('sparklamp_config');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setGoogleKey(parsed.googleApiKey || '');
        setLivekitUrl(parsed.livekitUrl || '');
        setLivekitKey(parsed.livekitApiKey || '');
        setLivekitSecret(parsed.livekitApiSecret || '');
        setMqttTopic(parsed.mqttTopic || DEFAULT_MQTT_TOPIC);
        setMqttBroker(parsed.mqttBrokerUrl || DEFAULT_MQTT_BROKER);
      } catch (e) {
        console.error("Failed to load saved config");
      }
    }
  }, []);

  const handleBrokerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setMqttBroker(val);

    // Browser Protocol Validation
    if (val.startsWith('mqtt://')) {
      setProtocolWarning('Browsers cannot connect via TCP (mqtt://). Please use WebSockets (ws://).');
    } else if (val.startsWith('mqtts://')) {
      setProtocolWarning('Browsers cannot connect via SSL TCP (mqtts://). Please use Secure WebSockets (wss://).');
    } else if (val.startsWith('http')) {
      setProtocolWarning('MQTT URL should start with ws:// or wss://, not http.');
    } else {
      setProtocolWarning(null);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Block invalid protocols
    if (mqttBroker.startsWith('mqtt:') || mqttBroker.startsWith('mqtts:')) {
        return; 
    }

    if (googleKey && mqttTopic && mqttBroker) {
      const config: AppConfig = {
        googleApiKey: googleKey,
        livekitUrl,
        livekitApiKey: livekitKey,
        livekitApiSecret: livekitSecret,
        mqttBrokerUrl: mqttBroker,
        mqttTopic
      };
      
      // Save to localStorage
      localStorage.setItem('sparklamp_config', JSON.stringify(config));
      
      onConnect(config);
    }
  };

  if (connectionState === ConnectionState.CONNECTED) return null;

  return (
    <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full p-8 shadow-2xl max-h-[90vh] overflow-y-auto scrollbar-hide">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-white">SparkLamp Setup</h2>
          <div className="text-xs px-2 py-1 bg-blue-900/30 border border-blue-500/30 rounded text-blue-300">
            Web Controller
          </div>
        </div>
        
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Section 1: The Brain (Google Gemini) */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-blue-400 uppercase tracking-wider">1. The Brain (Google Gemini)</h3>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">GOOGLE_API_KEY</label>
              <input
                type="password"
                required
                value={googleKey}
                onChange={(e) => setGoogleKey(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:ring-1 focus:ring-blue-500 outline-none text-sm"
                placeholder="AIza..."
              />
            </div>
          </div>

          {/* Section 2: LiveKit (Optional Transport) */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-purple-400 uppercase tracking-wider">2. LiveKit (Presence & A/V)</h3>
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">LIVEKIT_URL</label>
                <input
                  type="text"
                  value={livekitUrl}
                  onChange={(e) => setLivekitUrl(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:ring-1 focus:ring-purple-500 outline-none text-sm"
                  placeholder="wss://..."
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">API_KEY</label>
                  <input
                    type="text"
                    value={livekitKey}
                    onChange={(e) => setLivekitKey(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:ring-1 focus:ring-purple-500 outline-none text-sm"
                    placeholder="API Key"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">API_SECRET</label>
                  <input
                    type="password"
                    value={livekitSecret}
                    onChange={(e) => setLivekitSecret(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:ring-1 focus:ring-purple-500 outline-none text-sm"
                    placeholder="Secret"
                  />
                </div>
              </div>
            </div>
            <p className="text-[10px] text-slate-500">
              * LiveKit parameters are optional. If provided, you will join the room "room-01" with camera enabled.
            </p>
          </div>

          {/* Section 3: The Hands (MQTT) */}
          <div className="space-y-3 border-t border-slate-800 pt-4">
             <div className="flex justify-between items-center cursor-pointer" onClick={() => setShowAdvanced(!showAdvanced)}>
                <h3 className="text-sm font-semibold text-orange-400 uppercase tracking-wider">3. The Hands (MQTT)</h3>
                <span className="text-xs text-slate-500">{showAdvanced ? 'Hide' : 'Edit'}</span>
             </div>
             
             {showAdvanced && (
               <div className="space-y-3">
                 <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">MQTT Broker URL (WebSocket)</label>
                  <input
                    type="text"
                    required
                    value={mqttBroker}
                    onChange={handleBrokerChange}
                    className={`w-full bg-slate-800 border rounded-lg px-3 py-2 text-white focus:ring-1 outline-none text-sm ${
                        protocolWarning ? 'border-red-500 focus:ring-red-500' : 'border-slate-700 focus:ring-orange-500'
                    }`}
                    placeholder="wss://broker.emqx.io:8084/mqtt"
                  />
                  {protocolWarning && (
                      <p className="text-red-400 text-xs mt-1 font-medium">⚠️ {protocolWarning}</p>
                  )}
                  
                  {/* Protocol Examples Helper */}
                  <div className="mt-3 bg-slate-800/50 rounded-lg p-3 text-[10px] border border-slate-800">
                      <p className="text-slate-400 font-semibold mb-1">Browser Protocol Support:</p>
                      <ul className="space-y-1.5 text-slate-500 font-mono">
                          <li className="flex items-start gap-2">
                             <span className="text-green-400 whitespace-nowrap">wss://</span>
                             <span>Secure WebSocket (Port 8084/443). Required for HTTPS sites.</span>
                          </li>
                          <li className="flex items-start gap-2">
                             <span className="text-yellow-400 whitespace-nowrap">ws://</span>
                             <span>WebSocket (Port 8083/80). Only for localhost/HTTP.</span>
                          </li>
                          <li className="flex items-start gap-2 opacity-50">
                             <span className="text-red-400 whitespace-nowrap">mqtt://</span>
                             <span>TCP. <strong>Not supported in browsers.</strong> Use for ESP32 only.</span>
                          </li>
                      </ul>
                  </div>
                 </div>
                 
                 <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">MQTT Topic</label>
                  <input
                    type="text"
                    required
                    value={mqttTopic}
                    onChange={(e) => setMqttTopic(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:ring-1 focus:ring-orange-500 outline-none text-sm"
                    placeholder="sparklamp/device_id/command"
                  />
                  <p className="text-[10px] text-slate-500 mt-1">Use a unique topic per device (e.g. sparklamp/{'{mac_address}'}/command)</p>
                 </div>
               </div>
             )}
             {!showAdvanced && (
                 <div className="text-xs text-slate-600 space-y-1">
                     <div>Broker: {mqttBroker}</div>
                     <div>Topic: {mqttTopic}</div>
                 </div>
             )}
          </div>

          <button
            type="submit"
            disabled={connectionState === ConnectionState.CONNECTING || !!protocolWarning}
            className={`w-full py-3 rounded-xl font-bold text-white transition mt-6 shadow-lg ${
              connectionState === ConnectionState.CONNECTING || !!protocolWarning
                ? 'bg-gradient-to-r from-blue-700 to-purple-700 opacity-50 cursor-not-allowed'
                : 'bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500'
            }`}
          >
            {connectionState === ConnectionState.CONNECTING ? 'Initializing Agent...' : 'Start Agent'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default SettingsModal;