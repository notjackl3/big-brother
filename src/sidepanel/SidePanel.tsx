import React, { useState, useEffect, useRef } from 'react';
import { sendMessageToContent } from '../utils/messaging';
import type { Message, AgentStatus } from '../types/messages';

// Extend Window interface for Web Speech API
declare global {
  interface Window {
    webkitSpeechRecognition: any;
    SpeechRecognition: any;
  }
}

const SidePanel: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [speechOutputEnabled, setSpeechOutputEnabled] = useState(false);
  const [showMicInstructions, setShowMicInstructions] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [micPermissionGranted, setMicPermissionGranted] = useState<boolean | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const spokenMessageIdsRef = useRef<Set<string>>(new Set());
  const recognitionRef = useRef<any>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Check microphone permission on mount
  useEffect(() => {
    checkMicrophonePermission();
    
    // Check periodically in case permission is granted from settings page
    const interval = setInterval(checkMicrophonePermission, 2000);
    return () => clearInterval(interval);
  }, []);

  // Initialize speech recognition if permission is granted
  useEffect(() => {
    if (micPermissionGranted === true) {
      initializeSpeechRecognition();
    }
  }, [micPermissionGranted]);

  const checkMicrophonePermission = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setMicPermissionGranted(false);
        return;
      }

      // Try to access microphone to check permission
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      
      // Permission is granted
      setMicPermissionGranted(true);
      setShowMicInstructions(false);
    } catch (error: any) {
      // Permission is not granted
      setMicPermissionGranted(false);
    }
  };

  const initializeSpeechRecognition = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setInputValue(transcript);
        setIsListening(false);
      };

      recognition.onerror = (event: any) => {
        console.error('Speech recognition error:', event.error);
        setIsListening(false);
        
        if (event.error === 'not-allowed') {
          setMicPermissionGranted(false);
          setShowMicInstructions(true);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }
  };

  // ElevenLabs text-to-speech function
  const speakWithElevenLabs = async (text: string, messageId: string) => {
    // Skip if already spoken
    if (spokenMessageIdsRef.current.has(messageId)) {
      console.log('TTS: Message already spoken, skipping:', messageId);
      return;
    }

    // Stop any currently playing audio
    if (currentAudioRef.current) {
      console.log('TTS: Stopping previous audio');
      currentAudioRef.current.pause();
      currentAudioRef.current.currentTime = 0;
      if (currentAudioRef.current.src) {
        URL.revokeObjectURL(currentAudioRef.current.src);
      }
      currentAudioRef.current = null;
    }

    try {
      // Get API key from environment variable
      const apiKey = import.meta.env.VITE_ELEVENLABS_API_KEY;
      const voiceId = import.meta.env.VITE_ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Default voice: Rachel

      console.log('ElevenLabs TTS - API Key present:', !!apiKey, 'Voice ID:', voiceId);
      
      if (!apiKey || apiKey === 'your_elevenlabs_api_key_here') {
        console.warn('ElevenLabs API key not found. Please set VITE_ELEVENLABS_API_KEY in your .env file.');
        console.warn('Current API key value:', apiKey ? 'Set (but may be placeholder)' : 'Not set');
        return;
      }

      console.log('ElevenLabs TTS - Making API call for text:', text.substring(0, 50) + '...');

      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_turbo_v2_5', // Updated to newer model available on free tier
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `ElevenLabs API error: ${response.status} ${response.statusText}`;
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.detail?.message) {
            errorMessage = `ElevenLabs API error: ${errorJson.detail.message}`;
          }
        } catch {
          // If JSON parsing fails, use the text as is
          if (errorText) {
            errorMessage = `ElevenLabs API error: ${errorText}`;
          }
        }
        throw new Error(errorMessage);
      }

      const audioBlob = await response.blob();
      console.log('TTS: Audio blob received, size:', audioBlob.size, 'bytes');
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      
      // Store reference to current audio for stopping
      currentAudioRef.current = audio;
      
      // Set volume to ensure it's audible
      audio.volume = 1.0;

      console.log('TTS: Attempting to play audio...');
      await new Promise((resolve, reject) => {
        audio.onended = () => {
          console.log('TTS: Audio playback completed');
          URL.revokeObjectURL(audioUrl);
          currentAudioRef.current = null;
          resolve(undefined);
        };
        audio.onerror = (e) => {
          console.error('TTS: Audio playback error:', e);
          URL.revokeObjectURL(audioUrl);
          currentAudioRef.current = null;
          reject(new Error('Audio playback failed'));
        };
        audio.oncanplay = () => {
          console.log('TTS: Audio can play');
        };
        
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              console.log('TTS: Audio started playing successfully');
            })
            .catch((error) => {
              console.error('TTS: Audio play() promise rejected:', error);
              reject(error);
            });
        } else {
          console.log('TTS: Audio play() returned undefined');
        }
      });

      // Mark as spoken
      spokenMessageIdsRef.current.add(messageId);
    } catch (error: any) {
      console.error('Error with ElevenLabs TTS:', error);
      // Log more details for debugging
      if (error.message) {
        console.error('ElevenLabs error details:', error.message);
      }
    }
  };

  // Text-to-speech for new agent messages
  useEffect(() => {
    console.log('TTS Effect triggered - speechOutputEnabled:', speechOutputEnabled, 'messages.length:', messages.length);
    
    if (!speechOutputEnabled) {
      console.log('TTS: Speech output is disabled');
      return;
    }
    
    if (messages.length === 0) {
      console.log('TTS: No messages to speak');
      return;
    }

    const lastMessage = messages[messages.length - 1];
    console.log('TTS: Last message:', { role: lastMessage.role, id: lastMessage.id, alreadySpoken: spokenMessageIdsRef.current.has(lastMessage.id) });
    
    // Only speak new agent messages that haven't been spoken yet
    if (lastMessage.role === 'agent' && !spokenMessageIdsRef.current.has(lastMessage.id)) {
      console.log('TTS: Speaking new agent message:', lastMessage.id, 'Content:', lastMessage.content.substring(0, 50));
      speakWithElevenLabs(lastMessage.content, lastMessage.id);
    } else {
      console.log('TTS: Skipping message - not agent or already spoken');
    }
  }, [messages, speechOutputEnabled]);

  // Load messages from storage on mount
  useEffect(() => {
    chrome.storage.local.get(['chatHistory'], (result) => {
      if (result.chatHistory) {
        setMessages(result.chatHistory);
      }
    });
  }, []);

  // Save messages to storage whenever they change
  useEffect(() => {
    if (messages.length > 0) {
      chrome.storage.local.set({ chatHistory: messages });
    }
  }, [messages]);

  const handleSendMessage = async () => {
    if (!inputValue.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputValue,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');
    setStatus('thinking');

    try {
      // Send message to content script
      const response = await sendMessageToContent({
        type: 'USER_PROMPT',
        payload: { prompt: inputValue },
      });

      setStatus('acting');

      // Simulate agent response (replace with actual LLM call later)
      setTimeout(() => {
        const agentMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'agent',
          content: response?.message || 'I received your request and inspected the DOM.',
          timestamp: new Date().toISOString(),
        };

        setMessages((prev) => [...prev, agentMessage]);
        setStatus('idle');
      }, 1000);
    } catch (error) {
      console.error('Error sending message:', error);
      
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'agent',
        content: 'Error: Could not communicate with the page. Make sure you have a tab open.',
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, errorMessage]);
      setStatus('idle');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const clearHistory = () => {
    setMessages([]);
    chrome.storage.local.remove(['chatHistory']);
    spokenMessageIdsRef.current.clear();
  };

  const toggleSpeechInput = async () => {
    // Check permission first
    await checkMicrophonePermission();

    if (micPermissionGranted !== true) {
      // Permission not granted - redirect to settings and show instructions
      const extensionId = chrome.runtime.id;
      const settingsUrl = `chrome://settings/content/siteDetails?site=chrome-extension://${extensionId}`;
      chrome.tabs.create({ url: settingsUrl });
      setShowMicInstructions(true);
      return;
    }

    // Permission is granted - use speech recognition
    if (!recognitionRef.current) {
      return;
    }

    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      try {
        recognitionRef.current.start();
      } catch (error) {
        console.error('Error starting speech recognition:', error);
        setIsListening(false);
      }
    }
  };

  const toggleSpeechOutput = () => {
    const newState = !speechOutputEnabled;
    console.log('TTS: Toggling speech output to:', newState);
    
    // Stop any currently playing audio when toggling off
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.currentTime = 0;
      currentAudioRef.current = null;
    }
    
    setSpeechOutputEnabled(newState);
    // Clear spoken messages when toggling off so they can be re-spoken if toggled back on
    if (!newState) {
      spokenMessageIdsRef.current.clear();
      console.log('TTS: Cleared spoken messages history');
    } else {
      console.log('TTS: Speech output enabled - will speak new agent messages');
    }
  };

  const getStatusColor = () => {
    switch (status) {
      case 'thinking':
        return 'bg-yellow-500';
      case 'acting':
        return 'bg-blue-500';
      default:
        return 'bg-green-500';
    }
  };

  const getStatusText = () => {
    switch (status) {
      case 'thinking':
        return 'Thinking...';
      case 'acting':
        return 'Acting...';
      default:
        return 'Idle';
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Microphone Instructions Banner */}
      {showMicInstructions && (
        <div className="bg-orange-500 text-white px-4 py-4 border-b-2 border-orange-600">
          <div className="flex items-start gap-3">
            <div className="text-2xl">🎤</div>
            <div className="flex-1">
              <h3 className="font-bold text-lg mb-2">Enable Microphone Access</h3>
              <p className="text-sm mb-3">
                To use speech-to-text, you need to enable microphone permissions for this extension.
              </p>
              <ol className="text-sm list-decimal list-inside space-y-1 mb-3">
                <li>Go to the Chrome settings tab that just opened</li>
                <li>Find "Microphone" in the permissions list</li>
                <li>Change it from "Block" to "Allow"</li>
                <li>Come back to this extension</li>
                <li>The microphone will automatically be enabled!</li>
              </ol>
              <button
                onClick={() => setShowMicInstructions(false)}
                className="text-sm underline hover:no-underline"
              >
                Dismiss (will check automatically)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 shadow-sm">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-800">Big Brother</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleSpeechOutput}
              className={`text-sm px-3 py-1 rounded transition-colors ${
                speechOutputEnabled
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'text-gray-600 hover:text-gray-800 hover:bg-gray-100'
              }`}
              title="Toggle speech output (ElevenLabs TTS)"
            >
              🔊 {speechOutputEnabled ? 'On' : 'Off'}
            </button>
            <button
              onClick={clearHistory}
              className="text-sm text-gray-600 hover:text-gray-800 px-3 py-1 rounded hover:bg-gray-100 transition-colors"
            >
              Clear History
            </button>
          </div>
        </div>
        
        {/* Status Indicator */}
        <div className="flex items-center gap-2 mt-2">
          <div className={`w-2 h-2 rounded-full ${getStatusColor()} animate-pulse`} />
          <span className="text-sm text-gray-600">{getStatusText()}</span>
        </div>
      </div>

      {/* Messages Container */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            <div className="text-center">
              <p className="text-lg mb-2">No messages yet</p>
              <p className="text-sm">Start a conversation to interact with the page</p>
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2 ${
                  message.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-800 border border-gray-200'
                }`}
              >
                <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                <p
                  className={`text-xs mt-1 ${
                    message.role === 'user' ? 'text-blue-200' : 'text-gray-400'
                  }`}
                >
                  {new Date(message.timestamp).toLocaleTimeString()}
                </p>
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="border-t border-gray-200 bg-white px-4 py-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Enter your prompt (e.g., 'Change my username')"
            disabled={status !== 'idle'}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
          />
          <button
            onClick={toggleSpeechInput}
            disabled={status !== 'idle'}
            className={`px-4 py-2 rounded-lg transition-colors font-medium ${
              isListening
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            } disabled:bg-gray-100 disabled:cursor-not-allowed`}
            title={micPermissionGranted ? "Speech to text input" : "Enable microphone access"}
          >
            🎤
          </button>
          <button
            onClick={handleSendMessage}
            disabled={!inputValue.trim() || status !== 'idle'}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium"
          >
            Send
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Press Enter to send • The agent will inspect and interact with the current page
          {isListening && <span className="text-red-600 ml-2">● Listening...</span>}
        </p>
      </div>

    </div>
  );
};

export default SidePanel;
