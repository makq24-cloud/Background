import { useState, useEffect, useRef } from 'react';
import { Upload, Plus, Trash2, PlayCircle } from 'lucide-react';
import { AppState } from '../App';
import { loadImageFile, drawImageToCanvas, canvasToImageData } from '../utils/imageUtils';

type Props = {
  state: AppState;
  updateState: (updates: Partial<AppState>) => void;
  goToStep: (step: number) => void;
};

export default function ImportStep({ state, updateState, goToStep }: Props) {
  const [dragActive, setDragActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queueInputRef = useRef<HTMLInputElement>(null);

  const processFile = async (file: File) => {
    try {
      setLoading(true);
      const img = await loadImageFile(file);
      const canvas = drawImageToCanvas(img);
      const imageData = canvasToImageData(canvas);
      updateState({
        sourceImage: imageData,
        croppedImage: null,
        canvasData: null,
        prealphaCanvas: null,
        currentStep: 2,
      });
      goToStep(2);
    } catch (error) {
      alert('Failed to load image: ' + error);
    } finally {
      setLoading(false);
    }
  };

  // If we re-entered step 1 mid-batch (via "Process Next" from ExportStep),
  // auto-load the queued file at the current index.
  useEffect(() => {
    const next = state.queuedImages[state.currentImageIndex];
    if (next && !state.sourceImage && !loading) {
      processFile(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      processFile(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };

  const addToQueue = (files: FileList | null) => {
    if (!files) return;
    updateState({
      queuedImages: [...state.queuedImages, ...Array.from(files)],
    });
  };

  const removeFromQueue = (index: number) => {
    updateState({
      queuedImages: state.queuedImages.filter((_, i) => i !== index),
    });
  };

  const startQueue = () => {
    if (state.queuedImages.length === 0) return;
    updateState({ currentImageIndex: 0 });
    processFile(state.queuedImages[0]);
  };

  const clearQueue = () => updateState({ queuedImages: [], currentImageIndex: 0 });

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h2 className="text-3xl font-bold">Import Image</h2>
        <p className="text-gray-400">
          Drop a single graphic to start, or queue many for batch processing.
        </p>
      </div>

      {loading && (
        <div className="bg-blue-900/30 border border-blue-500 rounded-lg p-4 text-center">
          <p className="text-blue-200">Loading image…</p>
        </div>
      )}

      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-12 text-center transition cursor-pointer ${
          dragActive
            ? 'border-blue-400 bg-blue-900/20'
            : 'border-gray-600 bg-gray-800/50 hover:border-gray-500 active:bg-gray-800'
        }`}
      >
        <Upload className="mx-auto mb-4" size={48} />
        <h3 className="text-xl font-semibold mb-2">Choose an image</h3>
        <p className="text-gray-400 mb-4">Tap here, or drag a file in on desktop</p>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileInput}
          disabled={loading}
          className="hidden"
        />
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Bulk Queue</h3>
          {state.queuedImages.length > 0 && (
            <button onClick={clearQueue} className="text-xs text-gray-400 hover:text-gray-200 transition">
              Clear queue
            </button>
          )}
        </div>
        <p className="text-gray-400 text-sm">Add multiple images, then start the queue to process them one-by-one.</p>

        <input
          ref={queueInputRef}
          type="file"
          multiple
          accept="image/*"
          onChange={(e) => { addToQueue(e.target.files); e.target.value = ''; }}
          className="hidden"
        />
        <div
          onClick={() => queueInputRef.current?.click()}
          className="border-2 border-dashed border-gray-600 rounded-lg p-6 text-center hover:border-gray-500 transition cursor-pointer"
        >
          <Plus size={24} className="mx-auto mb-2 text-gray-400" />
          <p className="text-gray-300">Add images to queue</p>
        </div>

        {state.queuedImages.length > 0 && (
          <>
            <div className="bg-gray-800 rounded-lg divide-y divide-gray-700 max-h-72 overflow-auto">
              {state.queuedImages.map((file, idx) => (
                <div key={idx} className="p-3 flex items-center justify-between">
                  <span className="text-sm text-gray-300 truncate pr-3">
                    <span className="text-gray-500 tabular-nums mr-2">{String(idx + 1).padStart(2, '0')}</span>
                    {file.name}
                  </span>
                  <button
                    onClick={() => removeFromQueue(idx)}
                    className="p-1 hover:bg-red-900/30 rounded transition shrink-0"
                  >
                    <Trash2 size={16} className="text-red-400" />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={startQueue}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg font-semibold transition"
            >
              <PlayCircle size={20} />
              Start Queue ({state.queuedImages.length} {state.queuedImages.length === 1 ? 'image' : 'images'})
            </button>
          </>
        )}
      </div>
    </div>
  );
}