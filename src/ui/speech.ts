// Push-to-talk speech recognition (Web Speech API; Chrome, Edge, Safari).

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const speechSupported = typeof window !== 'undefined' && ctor() !== null;

export class PushToTalk {
  private rec: Recognition | null = null;
  private finals = '';
  private interim = '';
  private resolve: ((text: string) => void) | null = null;
  listening = false;

  constructor(
    private readonly onInterim: (text: string) => void,
    private readonly onError: (message: string) => void,
  ) {}

  start(): void {
    const C = ctor();
    if (!C || this.listening) return;
    const rec = new C();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    this.finals = '';
    this.interim = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finals += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.interim = interim;
      this.onInterim((this.finals + interim).trim());
    };
    rec.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') this.onError(`speech recognition: ${e.error}`);
    };
    rec.onend = () => {
      this.listening = false;
      const text = (this.finals + ' ' + this.interim).trim();
      this.resolve?.(text);
      this.resolve = null;
      this.rec = null;
    };
    this.rec = rec;
    this.listening = true;
    rec.start();
  }

  /** Stop listening; resolves with everything heard. */
  stop(): Promise<string> {
    if (!this.rec) return Promise.resolve('');
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.rec!.stop();
    });
  }
}
