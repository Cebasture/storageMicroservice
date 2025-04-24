export const cleanupUpload = async (uuid) => {
  try {
    const uploadData = activeUploads.get(uuid);
    if (uploadData) {
      const { tempDir, manifestStream } = uploadData;
      if (manifestStream && !manifestStream.closed) {
        manifestStream.end('#EXT-X-ENDLIST\n');
      }
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      activeUploads.delete(uuid);
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
};