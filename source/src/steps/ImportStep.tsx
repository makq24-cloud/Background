import { useState, useEffect, useRef } from 'react';
import { Upload } from 'lucide-react';
import { AppState } from '../App';
import { loadImageFile, drawImageToCanvas, canvasToImageData } from '../utils/imageUtils';

type Props = {
  state: AppState;
  updateState: (updates: Partial<AppState>) => void;
  goToStep: (step: number) => void;
};

export default function ImportStep({ state, updateState, goToStep }: Props) {
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load a file and go straight to Trim — no "start queue" step. If several
  // files were picked they ride along as the batch queue.
  const loadAndAdvance = async (file: File, queue: File[], index: number) => {
    try {
      setLoading(true);
      const img = await loadImageFile(file);
      const imageData = canvasToImageData(drawImageToCanvas(img));
      updateState({
        sourceImage: imageData,
        croppedImage: null,
        canvasData: null,
        prealphaCanvas: null,
        queuedImages: queue,
        currentImageIndex: index,
        currentStep: 2,
      });
      goToStep(2);
    } catch (error) {
      alert('Failed to load image: ' + error);
    } finally {
      setLoading(false);
    }
  };

  // Re-entered step 1 mid-batch (via "Next Image" on Export) — auto-load the
  // queued file at the current index.
  useEffect(() => {
    const next = state.queuedImages[state.currentImageIndex];
    if (next && !state.sourceImage && !loading) {
      loadAndAdvance(next, state.queuedImages, state.currentImageIndex);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (files.length === 0) return;
    // One image: just process it. Several: queue them, start on the first.
    loadAndAdvance(files[0], files.length > 1 ? files : [], 0);
  };

  return (
    <div className="h-full flex flex-col items-center justify-center gap-3">
      <button
        onClick={() => inputRef.current?.click()}
        disabled={loading}
        className="w-full max-w-sm flex flex-col items-center gap-2 border-2 border-dashed border-gray-600 rounded-2xl px-6 py-12 bg-gray-800/50 hover:border-gray-500 active:bg-gray-800 transition disabled:opacity-50"
      >
        <Upload size={40} className="text-gray-300" />
        <span className="text-lg font-semibold">{loading ? 'Loading…' : 'Choose image'}</span>
        <span className="text-xs text-gray-400">Pick one — or several to batch</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={onPick}
        className="hidden"
      />
    </div>
  );
}
