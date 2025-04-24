export const getAudioDuration = async (filePath) => {
    try {
      const metadata = await ffprobe(filePath);
      return metadata.format.duration;
    } catch (err) {
      console.error(`Error getting duration for ${filePath}:`, err);
      return config.hls.segmentTime;
    }
  };