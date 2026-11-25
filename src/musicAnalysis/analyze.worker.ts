import { analyzeSamples } from './analyze';

self.onmessage = ({ data }: MessageEvent<Float32Array>) => {
  try {
    self.postMessage(analyzeSamples(data));
  } catch {
    self.postMessage(null);
  }
};
