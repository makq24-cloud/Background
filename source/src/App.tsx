import { useState, useEffect, useRef } from 'react';
import { ChevronLeft } from 'lucide-react';
import ImportStep from './steps/ImportStep';
import CropStep from './steps/CropStep';
import PlatenStep from './steps/PlatenStep';
import AlphaStep from './steps/AlphaStep';
import RestoreStep from './steps/RestoreStep';
import ExportStep from './steps/ExportStep';
import { loadSession, saveSession, clearSession, PersistedSession } from './utils/persistence';

export type AppState = {
  currentStep: number;
  sourceImage: ImageData | null;
  croppedImage: ImageData | null;
  platenDimensions: { width: number; height: number } | null;
  platenName: string;
  canvasData: ImageData | null;
  prealphaCanvas: ImageData | null;
  alphaSettings: {
    targetColor: [number, number, number];
    alphaBase: number;
    alphaContrast: number;
  };
  alphaUserTuned: boolean;
  queuedImages: File[];
  currentImageIndex: number;
};

const STEP_NAMES = ['Import', 'Trim', 'Platen', 'Background', 'Touch-Up', 'Export'];

const INITIAL_STATE: AppState = {
  currentStep: 1,
  sourceImage: null,
  croppedImage: null,
  platenDimensions: null,
  platenName: '',
  canvasData: null,
  prealphaCanvas: null,
  alphaSettings: {
    targetColor: [255, 255, 255],
    alphaBase: 10,
    alphaContrast: 15,
  },
  alphaUserTuned: false,
  queuedImages: [],
  currentImageIndex: 0,
};

function App() {
  const [state, setState] = useState<AppState>(INITIAL_STATE);
  const [resumable, setResumable] = useState<PersistedSession | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const hydratedRef = useRef(false);
  const mainRef = useRef<HTMLElement>(null);

  // Each step is its own screen — reset scroll to the top on every step
  // change so a step never opens scrolled halfway down.
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [state.currentStep]);

  // Check for a resumable session on first mount. Don't auto-apply — the
  // user might want a clean slate. Show a banner on the import screen instead.
  useEffect(() => {
    let cancelled = false;
    loadSession().then(s => {
      if (cancelled) return;
      if (s) setResumable(s);
      hydratedRef.current = true;
    });
    return () => { cancelled = true; };
  }, []);

  // Debounced save of just the lightweight metadata + queued files.
  // Large ImageData buffers (canvasData etc.) are intentionally NOT persisted.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      if (state.queuedImages.length === 0) {
        // Nothing meaningful to resume — keep storage clean.
        clearSession();
      } else {
        saveSession({
          currentStep: state.currentStep,
          currentImageIndex: state.currentImageIndex,
          alphaSettings: state.alphaSettings,
          platenDimensions: state.platenDimensions,
          platenName: state.platenName,
          queuedImages: state.queuedImages,
          alphaUserTuned: state.alphaUserTuned,
        });
      }
    }, 600);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [
    state.currentStep,
    state.currentImageIndex,
    state.alphaSettings,
    state.platenDimensions,
    state.platenName,
    state.queuedImages,
    state.alphaUserTuned,
  ]);

  const goToStep = (step: number) => {
    setState(prev => ({ ...prev, currentStep: step }));
  };

  const goBack = () => {
    if (state.currentStep > 1) {
      goToStep(state.currentStep - 1);
    }
  };

  const updateState = (updates: Partial<AppState>) => {
    setState(prev => ({ ...prev, ...updates }));
  };

  const resumeSession = () => {
    if (!resumable) return;
    // Resume metadata, but always restart at step 1 so ImportStep re-loads
    // the current file fresh — we never persisted the heavy ImageData.
    setState({
      ...INITIAL_STATE,
      currentImageIndex: resumable.currentImageIndex,
      alphaSettings: resumable.alphaSettings,
      platenDimensions: resumable.platenDimensions,
      platenName: resumable.platenName,
      queuedImages: resumable.queuedImages,
      alphaUserTuned: resumable.alphaUserTuned,
    });
    setResumable(null);
  };

  const discardSession = () => {
    setResumable(null);
    clearSession();
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col">
      <header
        className="bg-gray-800 border-b border-gray-700 px-4 sm:px-6"
        style={{
          // Pad the top by the iOS safe area (the status bar / notch height
          // in standalone PWA mode) so content doesn't render under it.
          paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.625rem)',
          paddingBottom: '0.625rem',
        }}
      >
        <div className="max-w-7xl mx-auto flex items-center gap-3">
          {state.currentStep > 1 ? (
            <button
              onClick={goBack}
              aria-label="Back"
              className="p-1.5 -ml-1.5 rounded-lg hover:bg-gray-700 active:bg-gray-600 transition shrink-0"
            >
              <ChevronLeft size={24} />
            </button>
          ) : (
            <div className="w-[33px] shrink-0" />
          )}

          <div className="flex items-center gap-1.5 shrink-0">
            {STEP_NAMES.map((_, i) => {
              const idx = i + 1;
              const active = idx === state.currentStep;
              const done = idx < state.currentStep;
              return (
                <div
                  key={i}
                  className={`h-2 rounded-full transition-all ${
                    active
                      ? 'w-6 bg-blue-500'
                      : done
                        ? 'w-2 bg-blue-500/60'
                        : 'w-2 bg-gray-600'
                  }`}
                />
              );
            })}
          </div>

          <div className="flex-1 text-center font-semibold truncate">
            {STEP_NAMES[state.currentStep - 1]}
          </div>

          {state.queuedImages.length > 0 ? (
            <div className="text-xs text-blue-300 bg-blue-900/30 border border-blue-700/40 rounded-lg px-2 py-1 tabular-nums shrink-0">
              {state.currentImageIndex + 1} / {state.queuedImages.length}
            </div>
          ) : (
            <div className="w-[33px] shrink-0" />
          )}
        </div>
      </header>

      {resumable && state.currentStep === 1 && state.queuedImages.length === 0 && (
        <div className="bg-blue-900/30 border-b border-blue-700/40 px-4 py-2 sm:px-6">
          <div className="max-w-7xl mx-auto flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm">
              <span className="font-semibold">Resume previous session?</span>{' '}
              <span className="text-gray-300">
                {resumable.queuedImages.length} file{resumable.queuedImages.length === 1 ? '' : 's'}, was on #{resumable.currentImageIndex + 1}.
              </span>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={resumeSession} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition">Resume</button>
              <button onClick={discardSession} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition">Discard</button>
            </div>
          </div>
        </div>
      )}

      <main
        ref={mainRef}
        className="flex-1 overflow-auto"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="max-w-7xl mx-auto p-3 sm:p-6">
          {state.currentStep === 1 && (
            <ImportStep state={state} updateState={updateState} goToStep={goToStep} />
          )}
          {state.currentStep === 2 && (
            <CropStep state={state} updateState={updateState} goToStep={goToStep} />
          )}
          {state.currentStep === 3 && (
            <PlatenStep state={state} updateState={updateState} goToStep={goToStep} />
          )}
          {state.currentStep === 4 && (
            <AlphaStep state={state} updateState={updateState} goToStep={goToStep} />
          )}
          {state.currentStep === 5 && (
            <RestoreStep state={state} updateState={updateState} goToStep={goToStep} />
          )}
          {state.currentStep === 6 && (
            <ExportStep state={state} updateState={updateState} goToStep={goToStep} />
          )}
        </div>
      </main>
    </div>
  );
}

export default App;