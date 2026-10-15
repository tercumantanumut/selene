"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { SkillRecord } from "@/lib/skills/types";
import {
  detectSlashSkillTrigger,
  getRequiredSkillInputs,
  insertSkillRunIntent,
} from "@/lib/skills/skill-picker-utils";
import { resilientFetch, resilientPost } from "@/lib/utils/resilient-fetch";
import {
  createSpeechMediaRecorder,
  transcribeRecordedSpeech,
} from "@/lib/voice/browser-stt";
import type { ComposerSkillLite, SkillPickerMode } from "./composer-skill-picker";
import { MAX_SLASH_SKILL_RESULTS } from "./composer-skill-picker";
import type {
  PromptEnhancementAttachmentContext,
  PromptEnhancementConversationMessage,
} from "@/lib/ai/prompt-enhancement-history";
export type { PromptEnhancementAttachmentContext } from "@/lib/ai/prompt-enhancement-history";

// ---------------------------------------------------------------------------
// useVoiceRecording
// ---------------------------------------------------------------------------

interface VoiceTranscriptPayload {
  transcript: string;
  finalText: string;
  fallbackText: string;
  usedPostProcessing: boolean;
  voiceSessionId?: string;
}

interface UseVoiceRecordingOptions {
  sttEnabled: boolean;
  onTranscript: (payload: VoiceTranscriptPayload) => void;
  onTranscriptInserted?: () => void;
  onTranscriptPolished?: (polishedText: string, rawText: string, voiceSessionId: string) => void;
  /** Fired at the very start of a new recording session, before mic access. */
  onRecordingStart?: (voiceSessionId: string) => void;
  voicePostProcessing?: boolean;
  voiceAudioCues?: boolean;
  voiceActivationMode?: "tap" | "push";
}

interface UseVoiceRecordingReturn {
  isRecordingVoice: boolean;
  isTranscribingVoice: boolean;
  isPolishingTranscript: boolean;
  handleVoiceInput: () => Promise<void>;
  /** Push mode: start recording only (never stops). Use with onMouseDown/onTouchStart. */
  handleVoiceStart: () => Promise<void>;
  /** Push mode: stop recording only. Use with onMouseUp/onMouseLeave/onTouchEnd. */
  handleVoiceStop: () => void;
  analyserNode: AnalyserNode | null;
  /** The raw transcript from the last voice input (before post-processing), for auto-learn comparison */
  lastTranscriptRef: React.RefObject<string | null>;
  /** Whether the last transcript was AI-enhanced (post-processed) */
  wasAiEnhancedRef: React.RefObject<boolean>;
  /** Whether the last transcription attempt failed (used by capture session to cancel auto-send) */
  lastTranscriptionFailedRef: React.RefObject<boolean>;
}

export function useVoiceRecording(options: UseVoiceRecordingOptions): UseVoiceRecordingReturn {
  const {
    sttEnabled,
    onTranscript,
    onTranscriptInserted,
    onTranscriptPolished,
    onRecordingStart,
  } = options;
  const voiceAudioCues = options.voiceAudioCues ?? true;
  const voicePostProcessing = options.voicePostProcessing ?? false;

  const t = useTranslations("assistantUi");
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [isTranscribingVoice, setIsTranscribingVoice] = useState(false);
  const [isPolishingTranscript, setIsPolishingTranscript] = useState(false);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);
  const isRecordingRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<BlobPart[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const lastTranscriptRef = useRef<string | null>(null);
  const wasAiEnhancedRef = useRef(false);
  const lastTranscriptionFailedRef = useRef(false);
  const currentVoiceSessionIdRef = useRef<string | null>(null);

  const stopRecordingStream = useCallback(() => {
    if (recordingStreamRef.current) {
      for (const track of recordingStreamRef.current.getTracks()) {
        track.stop();
      }
      recordingStreamRef.current = null;
    }
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch {}
      audioContextRef.current = null;
    }
    setAnalyserNode(null);
  }, []);

  const playTone = useCallback((frequency: number, duration: number, type: OscillatorType = "sine") => {
    if (!voiceAudioCues) return;
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = frequency;
      gain.gain.value = 0.08;
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
      osc.onended = () => { try { ctx.close(); } catch {} };
    } catch {
      // Audio cue failed — non-critical
    }
  }, [voiceAudioCues]);

  useEffect(() => {
    return () => {
      try {
        const recorder = mediaRecorderRef.current;
        if (recorder && recorder.state !== "inactive") {
          recorder.stop();
        }
      } catch {
        // noop
      }
      stopRecordingStream();
      recordingChunksRef.current = [];
      mediaRecorderRef.current = null;
      if (audioContextRef.current) {
        try { audioContextRef.current.close(); } catch {}
        audioContextRef.current = null;
      }
      setAnalyserNode(null);
    };
  }, [stopRecordingStream]);

  // Shared helper: start a new recording session (mic access, MediaRecorder setup, etc.)
  const startRecording = useCallback(async () => {
    const voiceSessionId = crypto.randomUUID();
    currentVoiceSessionIdRef.current = voiceSessionId;

    // Fire onRecordingStart BEFORE any async work so the caller can snapshot
    // cursor position while it's still at the user's intended location.
    onRecordingStart?.(voiceSessionId);

    if (!sttEnabled || isTranscribingVoice) {
      return;
    }

    // Already recording — bail out (use ref to avoid stale closure)
    if (isRecordingRef.current) {
      return;
    }

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      toast.error(t("audio.voiceNotSupported"));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Create audio analyser for waveform visualization
      try {
        const audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);
        audioContextRef.current = audioCtx;
        setAnalyserNode(analyser);
      } catch {
        // Waveform not available — recording still works
      }

      const recorder = createSpeechMediaRecorder(stream);

      recordingStreamRef.current = stream;
      recordingChunksRef.current = [];
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        isRecordingRef.current = false;
        setIsRecordingVoice(false);
        setIsTranscribingVoice(false);
        setIsPolishingTranscript(false);
        mediaRecorderRef.current = null;
        recordingChunksRef.current = [];
        stopRecordingStream();
        if (audioContextRef.current) {
          try { audioContextRef.current.close(); } catch {}
          audioContextRef.current = null;
        }
        setAnalyserNode(null);
        toast.error(t("audio.voiceRecordingFailed"));
      };

      recorder.onstop = async () => {
        const sessionId = currentVoiceSessionIdRef.current ?? voiceSessionId;
        isRecordingRef.current = false;
        setIsRecordingVoice(false);
        playTone(440, 0.15);
        const mimeType = recorder.mimeType || "audio/webm";
        const chunks = recordingChunksRef.current;
        recordingChunksRef.current = [];
        mediaRecorderRef.current = null;
        stopRecordingStream();

        if (chunks.length === 0) {
          toast.error(t("audio.noAudioCaptured"));
          return;
        }

        const audioBlob = new Blob(chunks, { type: mimeType });
        if (audioBlob.size === 0) {
          toast.error(t("audio.noAudioCaptured"));
          return;
        }

        // Validate WebM EBML header to catch corrupted blobs before sending
        if (mimeType.includes("webm") && audioBlob.size >= 4) {
          const header = new Uint8Array(await audioBlob.slice(0, 4).arrayBuffer());
          if (header[0] !== 0x1A || header[1] !== 0x45 || header[2] !== 0xDF || header[3] !== 0xA3) {
            console.warn("[Voice] Invalid WebM EBML header detected, blob may be corrupted");
          }
        }

        setIsTranscribingVoice(true);
        setIsPolishingTranscript(false);
        try {
          const result = await transcribeRecordedSpeech({
            audioBlob,
            mimeType,
            postProcessingEnabled: voicePostProcessing,
            transcriptionFailedMessage: t("toast.transcriptionFailed"),
            noSpeechDetectedMessage: t("toast.noSpeechDetected"),
            onRawTranscript: (rawText) => {
              lastTranscriptRef.current = rawText;
              wasAiEnhancedRef.current = false;
              lastTranscriptionFailedRef.current = false;

              onTranscript({
                transcript: rawText,
                finalText: rawText,
                fallbackText: rawText,
                usedPostProcessing: false,
                voiceSessionId: sessionId,
              });
              onTranscriptInserted?.();

              setIsTranscribingVoice(false);
              setIsPolishingTranscript(voicePostProcessing);
            },
            onPolishedTranscript: (polishedText, rawText) => {
              wasAiEnhancedRef.current = true;
              onTranscriptPolished?.(polishedText, rawText, sessionId);
            },
            onPostProcessingFallback: () => {
              toast.info("Grammar cleanup unavailable. Using raw transcription.");
            },
          });

          // Preserve the raw transcript for auto-learn and restore, even when
          // post-processing updates the visible composer text.
          lastTranscriptRef.current = result.transcript;
          wasAiEnhancedRef.current = result.usedPostProcessing;
          lastTranscriptionFailedRef.current = false;
        } catch (error) {
          lastTranscriptionFailedRef.current = true;
          wasAiEnhancedRef.current = false;
          const errorMessage =
            error instanceof Error ? error.message : t("toast.transcriptionFailed");
          toast.error(errorMessage);
        } finally {
          setIsTranscribingVoice(false);
          setIsPolishingTranscript(false);
        }
      };

      // No timeslice — collect a single complete blob on stop.
      // Using timeslice (e.g. 250ms) causes Chromium's WebM muxer to emit
      // chunks without proper EBML headers on subsequent recordings in the
      // same session, leading to "Invalid file format" errors from Whisper.
      recorder.start();
      playTone(880, 0.12);
      isRecordingRef.current = true;
      setIsRecordingVoice(true);
    } catch (error) {
      let errorMessage: string;
      if (error instanceof DOMException) {
        switch (error.name) {
          case "NotAllowedError":
            errorMessage = "Microphone access denied. Check your browser and system privacy settings.";
            break;
          case "NotFoundError":
            errorMessage = "No microphone detected. Please connect a microphone.";
            break;
          case "NotReadableError":
            errorMessage = "Microphone is in use by another application.";
            break;
          default:
            errorMessage = "Failed to access microphone.";
        }
      } else {
        errorMessage = "Failed to access microphone.";
      }
      toast.error(errorMessage);
      isRecordingRef.current = false;
      setIsRecordingVoice(false);
      setIsTranscribingVoice(false);
      setIsPolishingTranscript(false);
      mediaRecorderRef.current = null;
      recordingChunksRef.current = [];
      stopRecordingStream();
    }
  }, [
    isTranscribingVoice,
    sttEnabled,
    stopRecordingStream,
    onRecordingStart,
    onTranscript,
    onTranscriptInserted,
    onTranscriptPolished,
    playTone,
    voicePostProcessing,
    t,
  ]);

  // Shared helper: stop an active recording
  const stopRecording = useCallback(() => {
    const activeRecorder = mediaRecorderRef.current;
    if (activeRecorder && activeRecorder.state !== "inactive") {
      activeRecorder.stop();
    }
  }, []);

  // Tap mode: toggle recording on/off
  const handleVoiceInput = useCallback(async () => {
    if (!sttEnabled || isTranscribingVoice) {
      return;
    }

    const activeRecorder = mediaRecorderRef.current;
    if (isRecordingVoice && activeRecorder && activeRecorder.state !== "inactive") {
      activeRecorder.stop();
      return;
    }

    await startRecording();
  }, [isRecordingVoice, isTranscribingVoice, sttEnabled, startRecording]);

  // Push mode: start recording only (never stops)
  const handleVoiceStart = useCallback(async () => {
    await startRecording();
  }, [startRecording]);

  // Push mode: stop recording only
  const handleVoiceStop = useCallback(() => {
    stopRecording();
  }, [stopRecording]);

  return {
    isRecordingVoice,
    isTranscribingVoice,
    isPolishingTranscript,
    handleVoiceInput,
    handleVoiceStart,
    handleVoiceStop,
    analyserNode,
    lastTranscriptRef,
    wasAiEnhancedRef,
    lastTranscriptionFailedRef,
  };
}

// ---------------------------------------------------------------------------
// useSkillPickerState
// ---------------------------------------------------------------------------
// Manages all skill picker state, loading, filtering, spotlight shortcut, and
// keyboard-driven focus management so the Composer component stays lean.

interface UseSkillPickerStateOptions {
  characterId: string | undefined;
  inputValue: string;
  cursorPosition: number;
  /** Ref to the composer textarea for outside-click and focus return */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Ref to the picker container element for outside-click detection */
  skillPickerRef: React.RefObject<HTMLDivElement | null>;
  /** Ref to the spotlight search input for auto-focus in spotlight mode */
  skillSearchInputRef: React.RefObject<HTMLInputElement | null>;
  /** Callback to update the input value when a skill is inserted */
  setInputValue: (value: string) => void;
  /** Callback to update cursor position after skill insertion */
  updateCursorPosition: (start: number, end?: number) => void;
}

interface UseSkillPickerStateReturn {
  skills: ComposerSkillLite[];
  filteredSkills: ComposerSkillLite[];
  isLoadingSkills: boolean;
  showSkillPicker: boolean;
  skillPickerQuery: string;
  selectedSkillIndex: number;
  skillPickerMode: SkillPickerMode;
  spotlightShortcutHint: string;
  openSpotlightSkillPicker: () => void;
  selectSkill: (skill: ComposerSkillLite) => void;
  closeSkillPicker: () => void;
  setSkillPickerQuery: (query: string) => void;
  setSelectedSkillIndex: (updater: ((index: number) => number) | number) => void;
}

function useSkillPickerState({
  characterId,
  inputValue,
  cursorPosition,
  inputRef,
  skillPickerRef,
  skillSearchInputRef,
  setInputValue,
  updateCursorPosition,
}: UseSkillPickerStateOptions): UseSkillPickerStateReturn {
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [skillPickerQuery, setSkillPickerQuery] = useState("");
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [skills, setSkills] = useState<ComposerSkillLite[]>([]);
  const [isLoadingSkills, setIsLoadingSkills] = useState(false);
  const [skillPickerMode, setSkillPickerMode] = useState<SkillPickerMode>("slash");

  const isApplePlatform =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  const spotlightShortcutHint = isApplePlatform ? "⌘⇧K" : "Ctrl+K";

  const filteredSkills = useMemo(() => {
    const query = skillPickerQuery.trim().toLowerCase();
    if (!query) {
      return skills.slice(0, MAX_SLASH_SKILL_RESULTS);
    }
    return skills
      .filter(
        (skill) =>
          skill.name.toLowerCase().includes(query) ||
          skill.description?.toLowerCase().includes(query) ||
          skill.category.toLowerCase().includes(query)
      )
      .slice(0, MAX_SLASH_SKILL_RESULTS);
  }, [skills, skillPickerQuery]);

  // Load skills when character changes
  useEffect(() => {
    let cancelled = false;

    const loadSkills = async () => {
      if (!characterId || characterId === "default") {
        setSkills([]);
        setIsLoadingSkills(false);
        return;
      }

      setIsLoadingSkills(true);
      const query = new URLSearchParams({ characterId, status: "active" });
      const { data, error } = await resilientFetch<{ skills?: SkillRecord[] }>(
        `/api/skills?${query.toString()}`,
        { retries: 0 }
      );

      if (cancelled) return;

      if (error || !Array.isArray(data?.skills)) {
        setSkills([]);
        setIsLoadingSkills(false);
        return;
      }

      setSkills(
        data.skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          category: skill.category || "general",
          inputParameters: skill.inputParameters,
        }))
      );
      setIsLoadingSkills(false);
    };

    void loadSkills();
    return () => { cancelled = true; };
  }, [characterId]);

  // Detect slash trigger in the input
  useEffect(() => {
    if (skillPickerMode === "spotlight") return;

    const slashTrigger = detectSlashSkillTrigger(inputValue, cursorPosition);
    if (slashTrigger) {
      setShowSkillPicker(true);
      setSkillPickerMode("slash");
      setSkillPickerQuery(slashTrigger.query);
      setSelectedSkillIndex(0);
      return;
    }

    setShowSkillPicker(false);
    setSkillPickerQuery("");
    setSelectedSkillIndex(0);
  }, [inputValue, cursorPosition, skillPickerMode]);

  // Clamp selected index when filtered list shrinks
  useEffect(() => {
    setSelectedSkillIndex((current) => {
      if (filteredSkills.length === 0) return 0;
      return Math.min(current, filteredSkills.length - 1);
    });
  }, [filteredSkills.length]);

  // Close picker when clicking outside
  useEffect(() => {
    if (!showSkillPicker) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (inputRef.current?.contains(target) || skillPickerRef.current?.contains(target)) return;
      setShowSkillPicker(false);
      setSkillPickerMode("slash");
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [showSkillPicker, inputRef, skillPickerRef]);

  // Spotlight keyboard shortcut
  const openSpotlightSkillPicker = useCallback(() => {
    setSkillPickerMode("spotlight");
    setShowSkillPicker(true);
    setSkillPickerQuery("");
    setSelectedSkillIndex(0);
  }, []);

  useEffect(() => {
    const handleSpotlightShortcut = (event: KeyboardEvent) => {
      if (!inputRef.current || document.activeElement !== inputRef.current) return;

      const normalizedKey = event.key.toLowerCase();
      const isShortcut = isApplePlatform
        ? event.metaKey && event.shiftKey && normalizedKey === "k"
        : event.ctrlKey && normalizedKey === "k";

      if (!isShortcut) return;

      event.preventDefault();
      openSpotlightSkillPicker();
    };

    window.addEventListener("keydown", handleSpotlightShortcut);
    return () => window.removeEventListener("keydown", handleSpotlightShortcut);
  }, [isApplePlatform, openSpotlightSkillPicker, inputRef]);

  // Auto-focus search input or textarea when picker opens/mode changes
  useEffect(() => {
    if (!showSkillPicker) return;

    if (skillPickerMode === "spotlight") {
      requestAnimationFrame(() => skillSearchInputRef.current?.focus());
      return;
    }

    requestAnimationFrame(() => inputRef.current?.focus());
  }, [showSkillPicker, skillPickerMode, skillSearchInputRef, inputRef]);

  const closeSkillPicker = useCallback(() => {
    setShowSkillPicker(false);
    setSkillPickerMode("slash");
  }, []);

  const selectSkill = useCallback(
    (skill: ComposerSkillLite) => {
      const requiredInputs = getRequiredSkillInputs(skill.inputParameters);
      const insertion = insertSkillRunIntent(inputValue, cursorPosition, skill.name, requiredInputs);
      setInputValue(insertion.value);
      updateCursorPosition(insertion.nextCursor);
      setShowSkillPicker(false);
      setSkillPickerMode("slash");

      requestAnimationFrame(() => {
        const textarea = inputRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(insertion.nextCursor, insertion.nextCursor);
      });
    },
    [inputValue, cursorPosition, setInputValue, updateCursorPosition, inputRef]
  );

  return {
    skills,
    filteredSkills,
    isLoadingSkills,
    showSkillPicker,
    skillPickerQuery,
    selectedSkillIndex,
    skillPickerMode,
    spotlightShortcutHint,
    openSpotlightSkillPicker,
    selectSkill,
    closeSkillPicker,
    setSkillPickerQuery,
    setSelectedSkillIndex,
  };
}

// ---------------------------------------------------------------------------
// usePromptEnhancement
// ---------------------------------------------------------------------------

interface UsePromptEnhancementOptions {
  inputValue: string;
  setInputValue: (value: string | ((previous: string) => string)) => void;
  characterId: string | undefined;
  sessionId?: string;
  /** Recent thread messages for conversation context */
  recentMessages: PromptEnhancementConversationMessage[];
  /** Returns current unsent composer attachments/images for enhancement context */
  getCurrentAttachments?: () => PromptEnhancementAttachmentContext[];
  /** Expands composer placeholders (e.g. pasted text blocks) before sending to enhancement API */
  expandInput?: (input: string) => string;
}

interface UsePromptEnhancementReturn {
  isEnhancing: boolean;
  enhancedContext: string | null;
  enhancementInfo: { filesFound?: number; chunksRetrieved?: number } | null;
  clearEnhancement: () => void;
  handleEnhance: () => Promise<void>;
}

export function usePromptEnhancement({
  inputValue,
  setInputValue,
  characterId,
  sessionId,
  recentMessages,
  getCurrentAttachments,
  expandInput,
}: UsePromptEnhancementOptions): UsePromptEnhancementReturn {
  const t = useTranslations("assistantUi");
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [enhancedContext, setEnhancedContext] = useState<string | null>(null);
  const [enhancementInfo, setEnhancementInfo] = useState<{
    filesFound?: number;
    chunksRetrieved?: number;
  } | null>(null);

  // Mirror the live composer value so the in-flight enhance request can detect
  // mid-flight typing on response. The useCallback closure captures inputValue
  // at click time; without this ref we would unconditionally overwrite whatever
  // the user typed while the request was in flight.
  const currentInputRef = useRef(inputValue);
  useEffect(() => {
    currentInputRef.current = inputValue;
  }, [inputValue]);

  const clearEnhancement = useCallback(() => {
    setEnhancedContext(null);
    setEnhancementInfo(null);
  }, []);

  useEffect(() => {
    if (!enhancedContext) {
      return;
    }

    if (inputValue.trim() === enhancedContext.trim()) {
      return;
    }

    clearEnhancement();
  }, [clearEnhancement, enhancedContext, inputValue]);

  const handleEnhance = useCallback(async () => {
    const trimmedInput = inputValue.trim();
    if (!trimmedInput || trimmedInput.length < 3) {
      toast.error(t("enhance.minChars"));
      return;
    }

    if (!characterId || characterId === "default") {
      toast.error(t("enhance.selectAgent"));
      return;
    }

    const enhancementInput = (expandInput ? expandInput(trimmedInput) : trimmedInput).trim();
    if (!enhancementInput || enhancementInput.length < 3) {
      toast.error(t("enhance.minChars"));
      return;
    }

    const currentAttachments = getCurrentAttachments?.() ?? [];

    setIsEnhancing(true);
    setEnhancementInfo(null);

    try {
      const { data, error: fetchError } = await resilientPost<{
        success?: boolean;
        enhancedPrompt?: string;
        filesFound?: number;
        chunksRetrieved?: number;
        usedLLM?: boolean;
        skipReason?: string;
        error?: string;
      }>(
        "/api/enhance-prompt",
        {
          input: enhancementInput,
          characterId,
          sessionId,
          useLLM: true,
          conversationContext: recentMessages,
          ...(currentAttachments.length > 0 ? { currentAttachments } : {}),
        },
        { timeout: 150_000, retries: 0 }
      );

      if (fetchError || !data) {
        toast.error(data?.error || fetchError || t("enhance.failed"));
        return;
      }

      const enhancedPrompt = data.enhancedPrompt?.trim() ?? "";

      if (data.success && enhancedPrompt) {
        // Bug guard: do not clobber mid-flight user typing. The reviewer flagged
        // that this branch unconditionally overwrote the textarea, so any keys
        // pressed during the request were silently lost. Compare the live
        // composer value (via ref) against the input we actually requested
        // enhancement for; if they diverge, keep the user's typing and tell
        // them what we have so they can re-enhance the new text if they want.
        const liveInput = currentInputRef.current.trim();
        if (liveInput && liveInput !== enhancementInput) {
          toast.info(t("enhance.inputChangedDuringEnhance"));
          return;
        }
        setInputValue(enhancedPrompt);
        setEnhancedContext(enhancedPrompt);
        setEnhancementInfo({ filesFound: data.filesFound, chunksRetrieved: data.chunksRetrieved });
        const llmIndicator = data.usedLLM ? " (LLM)" : "";
        toast.success(
          t("enhance.success", {
            files: data.filesFound ?? 0,
            chunks: data.chunksRetrieved ?? 0,
            llmIndicator,
          })
        );
      } else if (data.success) {
        toast.error(data.error || t("enhance.failed"));
        setEnhancedContext(null);
      } else {
        toast.info(data.skipReason || t("enhance.skipped"));
        setEnhancedContext(null);
      }
    } catch (error) {
      console.error("[Enhance] Error:", error);
      toast.error(t("enhance.failed"));
    } finally {
      setIsEnhancing(false);
    }
  }, [inputValue, characterId, sessionId, recentMessages, getCurrentAttachments, expandInput, setInputValue, t]);

  return { isEnhancing, enhancedContext, enhancementInfo, clearEnhancement, handleEnhance };
}
