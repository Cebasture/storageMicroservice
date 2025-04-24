export const notifyCentralServer = async (manifestUrl, duration, chunkCount) => {
    try {
      const response = await axios.post(
        config.centralServer.url,
        {
          manifest_url: manifestUrl,
          duration_seconds: duration,
          chunk_count: chunkCount,
          uploaded_at: new Date().toISOString()
        },
        {
          headers: {
            'Authorization': `Bearer ${config.centralServer.authToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log('Central server notified successfully:', response.data);
    } catch (err) {
      console.error('Failed to notify central server:', err.message);
      // Consider retry logic here if needed
    }
  };
  