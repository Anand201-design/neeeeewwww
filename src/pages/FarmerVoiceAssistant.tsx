import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Sparkles,
  Camera,
  X,
  Send,
  Bot,
  User,
  Leaf,
  MessageSquare,
} from "lucide-react";
import {
  askFarmerVoiceAssistant,
  fetchFarmerStudioTts,
  loadSavedFarmerDoubts,
  saveFarmerDoubt,
  FarmerVoiceAdvice,
} from "../services/farmerVoiceService";
import { tts, getSpeechLocale } from "../services/speechService";
import { validateImageFile } from "../utils/imageOptimizer";

interface ConversationTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  advice?: FarmerVoiceAdvice;
  timestamp: string;
}

export const FarmerVoiceAssistant: React.FC = () => {
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const [questionText, setQuestionText] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [attachedImage, setAttachedImage] = useState<File | null>(null);
  const [attachedPreview, setAttachedPreview] = useState<string | null>(null);

  // Voice recording & Audio states
  const [isListening, setIsListening] = useState(false);
  const [isWakeWordActive, setIsWakeWordActive] = useState(true);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [micVolume, setMicVolume] = useState(0);

  // Processing & result state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("Say 'Hey Aira' or tap the orb to talk");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Audio Playback state
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);

  // Refs
  const recognitionRef = useRef<any>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);

  // Keep track of active states inside callbacks
  const isListeningRef = useRef(isListening);
  isListeningRef.current = isListening;
  const isAnalyzingRef = useRef(isAnalyzing);
  isAnalyzingRef.current = isAnalyzing;
  const isPlayingAudioRef = useRef(isPlayingAudio);
  isPlayingAudioRef.current = isPlayingAudio;
  const isWakeWordActiveRef = useRef(isWakeWordActive);
  isWakeWordActiveRef.current = isWakeWordActive;

  useEffect(() => {
    loadSavedFarmerDoubts();
    const win = window as any;
    const SpeechRecognition = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSpeechSupported(false);
    }
  }, []);

  // Auto-scroll conversation feed
  useEffect(() => {
    if (conversationEndRef.current) {
      conversationEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [conversation, isAnalyzing]);

  // Audio Context & Browser Autoplay Unlock
  const unlockAudioContext = useCallback(() => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx && !audioContextRef.current) {
        audioContextRef.current = new AudioCtx();
      }
      if (audioContextRef.current && audioContextRef.current.state === "suspended") {
        audioContextRef.current.resume();
      }
      // Unlock speech synthesis
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        const silentUtter = new SpeechSynthesisUtterance("");
        silentUtter.volume = 0;
        window.speechSynthesis.speak(silentUtter);
      }
    } catch {
      // ignore
    }
  }, []);

  // Stop active TTS audio
  const stopActiveSpeech = useCallback(() => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
    }
    try {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    } catch {
      // ignore
    }
    tts.stop();
    setIsPlayingAudio(false);
  }, []);

  // Cleanup microphone audio meter
  const stopAudioMeter = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    setMicVolume(0);
  }, []);

  // Start real-time microphone volume meter for 3D orb reactivity
  const startAudioMeter = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const audioCtx = audioContextRef.current || new AudioCtx();
      audioContextRef.current = audioCtx;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateMeter = () => {
        if (!audioContextRef.current || audioContextRef.current.state === "closed") return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        setMicVolume(Math.min(1, avg / 60));
        animationFrameRef.current = requestAnimationFrame(updateMeter);
      };
      updateMeter();
    } catch {
      // ignore
    }
  }, []);

  const startContinuousListeningRef = useRef<any>(null);

  // Robust Continuous Speech Recognition Loop with Auto-Restart
  const startContinuousListening = useCallback(() => {
    if (isAnalyzingRef.current || isPlayingAudioRef.current || !speechSupported) return;

    unlockAudioContext();
    setErrorMsg(null);

    const win = window as any;
    const SpeechRecognition = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
      }

      const recognition = new SpeechRecognition();
      recognition.lang = "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setIsListening(true);
        setStatusMessage("Listening... Say 'Hey Aira' or speak your question");
        startAudioMeter();
      };

      recognition.onresult = (event: any) => {
        let interim = "";
        let finalTrans = "";

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) {
            finalTrans += res[0].transcript;
          } else {
            interim += res[0].transcript;
          }
        }

        if (interim) {
          setInterimTranscript(interim);
        }

        if (finalTrans) {
          const transcriptLower = finalTrans.toLowerCase().trim();
          setQuestionText(finalTrans);
          setInterimTranscript("");

          // Check wake word or natural speech
          if (
            isWakeWordActiveRef.current &&
            (transcriptLower.includes("aira") ||
              transcriptLower.startsWith("hey") ||
              transcriptLower.startsWith("hi"))
          ) {
            // Trigger question processing
            setTimeout(() => {
              handleSubmitDoubt(finalTrans);
            }, 300);
          } else if (transcriptLower.length > 3) {
            // Natural speech query
            setTimeout(() => {
              handleSubmitDoubt(finalTrans);
            }, 300);
          }
        }
      };

      recognition.onerror = (event: any) => {
        setIsListening(false);
        stopAudioMeter();
        if (event.error !== "no-speech" && event.error !== "aborted" && event.error !== "not-allowed") {
          console.warn("Speech recognition warning:", event.error);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
        stopAudioMeter();
        // Auto-restart recognition loop if not analyzing or speaking
        if (!isAnalyzingRef.current && !isPlayingAudioRef.current) {
          setTimeout(() => {
            if (!isListeningRef.current && !isAnalyzingRef.current && !isPlayingAudioRef.current) {
              startContinuousListeningRef.current?.();
            }
          }, 600);
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      setIsListening(false);
      stopAudioMeter();
    }
  }, [speechSupported, startAudioMeter, stopAudioMeter, unlockAudioContext]);

  startContinuousListeningRef.current = startContinuousListening;

  // Voice Response & Gemini Connection with dynamic window.speechSynthesis
  const speakAdviceWithSynthesis = useCallback(
    async (textToSpeak: string, langCode?: string) => {
      unlockAudioContext();
      stopActiveSpeech();
      setIsPlayingAudio(true);

      // Temporarily stop recognition while speaking
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // ignore
        }
      }
      setIsListening(false);
      stopAudioMeter();

      const bcp47 = getSpeechLocale(langCode || "en");

      if (typeof window !== "undefined" && window.speechSynthesis) {
        try {
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(textToSpeak);
          utterance.lang = bcp47;
          utterance.rate = 0.92;
          utterance.pitch = 1.0;
          utterance.volume = 0.9;

          utterance.onend = () => {
            setIsPlayingAudio(false);
            // Automatically resume continuous listening after speech ends
            setTimeout(() => {
              startContinuousListeningRef.current?.();
            }, 400);
          };

          utterance.onerror = () => {
            setIsPlayingAudio(false);
            setTimeout(() => {
              startContinuousListeningRef.current?.();
            }, 400);
          };

          window.speechSynthesis.speak(utterance);
          return;
        } catch {
          // fallback to tts manager
        }
      }

      // Fallback TTS
      tts.speak(textToSpeak, {
        lang: langCode || "en",
        onEnd: () => {
          setIsPlayingAudio(false);
          setTimeout(() => startContinuousListeningRef.current?.(), 400);
        },
        onError: () => {
          setIsPlayingAudio(false);
          setTimeout(() => startContinuousListeningRef.current?.(), 400);
        },
      });
    },
    [stopActiveSpeech, stopAudioMeter, unlockAudioContext]
  );

  // Submit question to Aira
  const handleSubmitDoubt = async (textInput?: string, fileOverride?: File | null) => {
    const rawText = (textInput !== undefined ? textInput : questionText).trim();
    const imageToSubmit = fileOverride !== undefined ? fileOverride : attachedImage;

    // Strip wake-word "hey aira" if present
    const cleanedText = rawText
      .replace(/^hey aira,?\s*/i, "")
      .replace(/^hi aira,?\s*/i, "")
      .replace(/^aira,?\s*/i, "")
      .trim();

    if (!cleanedText && !imageToSubmit) return;

    stopActiveSpeech();
    setIsListening(false);
    stopAudioMeter();
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    }

    const userTurn: ConversationTurn = {
      id: `user_${Date.now()}`,
      role: "user",
      text: cleanedText || "[Attached Crop Photo]",
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setConversation((prev) => [...prev, userTurn]);
    setQuestionText("");
    setAttachedImage(null);
    setAttachedPreview(null);
    setIsAnalyzing(true);
    setStatusMessage("Aira is analyzing your question...");
    setErrorMsg(null);

    const recentHistory = [...conversation, userTurn].slice(-6).map((c) => ({
      role: c.role,
      text: c.text,
    }));

    try {
      const result = await askFarmerVoiceAssistant({
        question: cleanedText || "Please inspect this crop image and provide guidance.",
        language: "en",
        imageFile: imageToSubmit,
        history: recentHistory,
      });

      saveFarmerDoubt(result);
      loadSavedFarmerDoubts();

      const assistantTurn: ConversationTurn = {
        id: `ai_${Date.now()}`,
        role: "assistant",
        text: result.spokenSummary,
        advice: result,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setConversation((prev) => [...prev, assistantTurn]);
      setStatusMessage(`Aira • ${result.crop || "Crop"} (${result.detectedLanguageName || "Auto-detected"})`);

      setTimeout(() => {
        speakAdviceWithSynthesis(result.spokenSummary, result.language);
      }, 250);
    } catch (err) {
      const fallbackMsg = "I'm having a little trouble connecting to my agricultural knowledge base right now, but generally ensure your crop gets balanced watering and proper sunlight. Please try asking again in a moment!";
      const assistantTurn: ConversationTurn = {
        id: `ai_${Date.now()}`,
        role: "assistant",
        text: fallbackMsg,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setConversation((prev) => [...prev, assistantTurn]);
      setStatusMessage("Ready");
      setTimeout(() => {
        speakAdviceWithSynthesis(fallbackMsg, "en");
      }, 250);
    } finally {
      setIsAnalyzing(false);
    }
  };



  // Stop listening
  const stopListeningSession = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    }
    setIsListening(false);
    stopAudioMeter();
    setStatusMessage("Listening paused");
  }, [stopAudioMeter]);

  // Activation flow: Greeting welcome
  const handleActivateAssistant = useCallback(() => {
    unlockAudioContext();
    stopActiveSpeech();
    const welcomeGreeting = "Hello! I am Aira. How can I help with your plants today?";
    setStatusMessage(welcomeGreeting);

    const welcomeTurn: ConversationTurn = {
      id: `welcome_${Date.now()}`,
      role: "assistant",
      text: welcomeGreeting,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    setConversation((prev) => [...prev, welcomeTurn]);

    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(welcomeGreeting);
      utter.lang = "en-US";
      utter.onend = () => {
        setTimeout(() => startContinuousListening(), 300);
      };
      window.speechSynthesis.speak(utter);
    } else {
      setTimeout(() => startContinuousListening(), 1500);
    }
  }, [stopActiveSpeech, startContinuousListening, unlockAudioContext]);

  // Toggle orb click
  const handleToggleOrb = () => {
    unlockAudioContext();
    if (isPlayingAudio) {
      stopActiveSpeech();
      startContinuousListening();
      return;
    }
    if (isListening) {
      stopListeningSession();
    } else {
      startContinuousListening();
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const validation = validateImageFile(file);
    if (!validation.valid) {
      setErrorMsg(validation.error || "Invalid file format");
      return;
    }
    setAttachedImage(file);
    setAttachedPreview(URL.createObjectURL(file));
  };

  const orbScale = isListening
    ? 1 + micVolume * 0.45
    : isPlayingAudio
      ? 1.12
      : isAnalyzing
        ? 1.06
        : 1.0;

  return (
    <div className="space-y-6 sm:space-y-8 max-w-4xl mx-auto pb-24 font-sans">
      {/* CLEAN 3D VOICE ASSISTANT INTERFACE CENTERED AROUND INTERACTIVE ORB */}
      <section
        className="relative overflow-hidden rounded-3xl bg-gradient-to-b from-[#0F231B] via-[#173126] to-[#0A1A12] border border-[#244737] shadow-2xl p-6 sm:p-10 text-white flex flex-col items-center text-center"
        onClick={unlockAudioContext}
      >
        {/* Top Status & Wake Word Indicator */}
        <div className="flex items-center justify-between w-full max-w-lg mb-6 text-xs text-[#B0C9BA]">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 backdrop-blur-md border border-white/15">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Wake Word Active ("Hey Aira")</span>
          </div>
          <button
            type="button"
            onClick={() => setIsWakeWordActive(!isWakeWordActive)}
            className="text-[11px] underline hover:text-white cursor-pointer"
          >
            {isWakeWordActive ? "Disable Wake Word" : "Enable Wake Word"}
          </button>
        </div>

        {/* 3D Botanical Orb & Visualizer */}
        <div className="relative my-8 cursor-pointer group" onClick={handleToggleOrb}>
          {/* Ripple rings when listening or speaking */}
          {(isListening || isPlayingAudio) && (
            <>
              <div className="absolute inset-0 rounded-full bg-emerald-500/20 animate-ping duration-1000 scale-125" />
              <div className="absolute -inset-4 rounded-full bg-emerald-400/15 animate-pulse scale-150" />
            </>
          )}

          {/* Core 3D Glowing Orb */}
          <div
            style={{ transform: `scale(${orbScale})` }}
            className={`relative w-44 h-44 sm:w-52 sm:h-52 rounded-full bg-gradient-to-tr from-[#176B4D] via-[#22C55E] to-[#10B981] p-1.5 shadow-[0_0_60px_rgba(34,197,94,0.45)] transition-transform duration-200 ${
              isListening ? "animate-pulse" : ""
            }`}
          >
            <div className="w-full h-full rounded-full bg-[#0F231B] flex flex-col items-center justify-center relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/20 via-transparent to-green-900/40 animate-spin-slow" />
              <div className="relative z-10 flex flex-col items-center space-y-2">
                <Leaf className="w-12 h-12 text-[#4ADE80] drop-shadow-[0_0_12px_rgba(74,222,128,0.8)]" />
                <span className="font-display font-bold text-sm tracking-widest text-emerald-300">
                  AIRA 3D
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Status Prompt */}
        <div className="max-w-md space-y-2">
          <h2 className="font-display font-bold text-lg sm:text-xl text-white">
            {isListening
              ? "Listening to you... Speak in any language"
              : isPlayingAudio
                ? "Aira is speaking... (Tap orb to stop)"
                : isAnalyzing
                  ? "Aira is diagnosing..."
                  : "Say 'Hey Aira' or Tap Orb to Talk"}
          </h2>
          <p className="text-xs sm:text-sm text-[#B0C9BA]">
            {statusMessage}
          </p>
          {interimTranscript && (
            <p className="text-xs italic text-emerald-300">
              "{interimTranscript}..."
            </p>
          )}
        </div>

        {/* Interactive Controls */}
        <div className="flex items-center gap-3 mt-6">
          <button
            type="button"
            onClick={handleToggleOrb}
            className={`inline-flex items-center gap-2 px-5 py-3 rounded-2xl font-bold text-xs sm:text-sm transition-all shadow-lg cursor-pointer ${
              isListening
                ? "bg-rose-600 hover:bg-rose-700 text-white"
                : isPlayingAudio
                  ? "bg-amber-600 hover:bg-amber-700 text-white"
                  : "bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-500 hover:to-green-500 text-white"
            }`}
          >
            {isListening ? (
              <>
                <MicOff className="w-4.5 h-4.5" />
                <span>Pause Listening</span>
              </>
            ) : isPlayingAudio ? (
              <>
                <VolumeX className="w-4.5 h-4.5" />
                <span>Stop Audio</span>
              </>
            ) : (
              <>
                <Mic className="w-4.5 h-4.5" />
                <span>Start Continuous Listening</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleActivateAssistant}
            className="px-4 py-3 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20 text-xs font-semibold text-emerald-200 transition-colors cursor-pointer"
          >
            Play Greeting
          </button>
        </div>

        {/* Ambient Organic Glow Layers */}
        <div className="pointer-events-none absolute -bottom-24 -right-24 w-72 h-72 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="pointer-events-none absolute -top-24 -left-24 w-72 h-72 rounded-full bg-green-500/10 blur-3xl" />
      </section>

      {/* Error Notice */}
      {errorMsg && (
        <div className="p-4 rounded-2xl bg-rose-950/40 border border-rose-900/60 text-xs text-rose-300 flex items-center justify-between">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)} className="p-1">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Conversation Feed & Latest Advice Card */}
      <section className="bg-white dark:bg-[#173126] border border-[#DCE7DF] dark:border-[#244737] rounded-3xl p-6 shadow-xl space-y-5">
        <div className="flex items-center justify-between border-b border-[#DCE7DF] dark:border-[#244737] pb-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4.5 h-4.5 text-[#176B4D] dark:text-[#8EAD9B]" />
            <h3 className="font-display font-bold text-sm text-[#163A2D] dark:text-[#F1F7F3]">
              Conversation & Diagnosis Feed
            </h3>
          </div>
          {conversation.length > 0 && (
            <button
              type="button"
              onClick={() => setConversation([])}
              className="text-xs text-[#668074] dark:text-[#8EAD9B] hover:text-rose-600 transition-colors cursor-pointer"
            >
              Clear Feed
            </button>
          )}
        </div>

        <div className="space-y-4 max-h-[400px] overflow-y-auto pr-1">
          {conversation.length === 0 ? (
            <div className="text-center py-12 text-[#668074] dark:text-[#8EAD9B] space-y-2">
              <Bot className="w-10 h-10 mx-auto opacity-50" />
              <p className="text-xs">No questions asked yet in this session.</p>
              <p className="text-[11px] opacity-80">
                Say "Hey Aira" or type your doubt below.
              </p>
            </div>
          ) : (
            conversation.map((turn) => {
              const isUser = turn.role === "user";

              return (
                <div
                  key={turn.id}
                  className={`flex items-start gap-3 ${isUser ? "flex-row-reverse text-right" : ""}`}
                >
                  <div
                    className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                      isUser
                        ? "bg-[#176B4D] text-white"
                        : "bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300"
                    }`}
                  >
                    {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                  </div>

                  <div
                    className={`max-w-[85%] rounded-2xl p-4 text-xs sm:text-sm ${
                      isUser
                        ? "bg-[#176B4D] text-white rounded-tr-xs"
                        : "bg-[#F6F9F5] dark:bg-[#12281E] border border-[#DCE7DF] dark:border-[#244737] text-[#163A2D] dark:text-[#F1F7F3] rounded-tl-xs"
                    }`}
                  >
                    <p className="leading-relaxed font-medium">{turn.text}</p>
                    {!isUser && (
                      <div className="mt-2 text-right">
                        <button
                          type="button"
                          onClick={() => speakAdviceWithSynthesis(turn.text, turn.advice?.language)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#E4F0E7] dark:bg-[#1D3B2D] text-[#176B4D] dark:text-[#8EAD9B] font-semibold text-[11px]"
                        >
                          <Volume2 className="w-3 h-3" />
                          <span>Listen</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
          {isAnalyzing && (
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 animate-pulse">
                <Bot className="w-4 h-4" />
              </div>
              <div className="bg-[#F6F9F5] dark:bg-[#12281E] border border-[#DCE7DF] dark:border-[#244737] rounded-2xl p-4 text-xs text-[#163A2D] dark:text-[#F1F7F3] rounded-tl-xs flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-600 animate-bounce [animation-delay:-0.3s]"></div>
                <div className="w-2 h-2 rounded-full bg-emerald-600 animate-bounce [animation-delay:-0.15s]"></div>
                <div className="w-2 h-2 rounded-full bg-emerald-600 animate-bounce"></div>
                <span className="font-medium italic ml-1">Aira is thinking and analyzing your crop...</span>
              </div>
            </div>
          )}
          <div ref={conversationEndRef} />
        </div>

        {/* Text Input & Photo Attachment Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmitDoubt();
          }}
          className="pt-2 border-t border-[#DCE7DF] dark:border-[#244737] space-y-3"
        >
          {attachedPreview && (
            <div className="relative inline-block">
              <img
                src={attachedPreview}
                alt="Attached preview"
                className="w-16 h-16 object-cover rounded-xl border border-[#176B4D]"
              />
              <button
                type="button"
                onClick={() => {
                  setAttachedImage(null);
                  setAttachedPreview(null);
                }}
                className="absolute -top-2 -right-2 p-1 rounded-full bg-rose-600 text-white"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              placeholder="Ask Aira in any language or dialect (e.g. 'Enna thakkali ila yellow aagudhu')..."
              className="flex-1 px-4 py-2.5 rounded-xl border border-[#DCE7DF] dark:border-[#244737] bg-[#F6F9F5] dark:bg-[#12281E] text-xs text-[#163A2D] dark:text-[#F1F7F3] focus:outline-hidden focus:border-[#176B4D]"
            />

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageSelect}
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-2.5 rounded-xl border border-[#DCE7DF] dark:border-[#244737] bg-[#F6F9F5] dark:bg-[#12281E] text-[#176B4D] dark:text-[#8EAD9B] hover:bg-[#E4F0E7] transition-colors cursor-pointer"
              title="Attach photo"
            >
              <Camera className="w-4 h-4" />
            </button>

            <button
              type="submit"
              disabled={isAnalyzing || (!questionText.trim() && !attachedImage)}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#176B4D] hover:bg-[#12563D] text-white text-xs font-bold transition-all shadow-sm cursor-pointer disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              <span>Send</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  );
};

export default FarmerVoiceAssistant;
