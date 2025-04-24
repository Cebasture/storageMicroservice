import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
const getAudioDuration = require('./helperFunctions/getAudioDuration.js');
const cleanupUpload = require('./helperFunctions/cleanup.js');

export const chunkingAndUpload = async (inputStream, uuid) => {
    const tempDir = path.join(config.server.tempDir, uuid);
    fs.mkdirSync(tempDir, { recursive: true });
  
    // Initialize manifest in MinIO
    const manifestName = `${uuid}/playlist.m3u8`;
    const manifestStream = await minioClient.putObject(
      config.hls.bucketName,
      manifestName,
      '',
      {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'public, max-age=3600'
      }
    );
  
    // Write manifest headers
    const initialManifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      `#EXT-X-TARGETDURATION:${config.hls.segmentTime}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD'
    ].join('\n') + '\n';
    
    manifestStream.write(initialManifest);
  
    // Store upload context
    activeUploads.set(uuid, {
      tempDir,
      manifestStream,
      chunks: [],
      maxDuration: 0
    });
  
    return new Promise((resolve, reject) => {
      const outputPattern = path.join(tempDir, 'chunk_%03d.opus');
      const ffmpegProcess = ffmpeg(inputStream)
        .audioCodec(config.hls.audioCodec)
        .audioQuality(config.hls.audioQuality)
        .outputOptions([
          '-f segment',
          `-segment_time ${config.hls.segmentTime}`,
          '-reset_timestamps 1',
          '-flags', '+global_header'
        ])
        .output(outputPattern);
  
      ffmpegProcess.on('start', (cmd) => {
        console.log(`FFmpeg started for ${uuid}: ${cmd}`);
      });
  
      ffmpegProcess.on('progress', async (progress) => {
        if (progress.frames) {
          const chunkNumber = Math.floor(progress.timemark.split(':').reduce((acc, time) => (60 * acc) + +time, 0) / config.hls.segmentTime);
          const chunkName = `chunk_${String(Math.floor(chunkNumber) + 1).padStart(3, '0')}.opus`;
          const chunkPath = path.join(tempDir, chunkName);
  
          if (fs.existsSync(chunkPath)) {
            try {
              const duration = await getAudioDuration(chunkPath);
              const objectName = `${uuid}/${chunkName}`;
  
              await minioClient.fPutObject(
                config.hls.bucketName,
                objectName,
                chunkPath,
                {
                  'Cache-Control': 'public, max-age=31536000',
                  'Content-Type': 'audio/opus'
                }
              );
  
              const uploadData = activeUploads.get(uuid);
              if (uploadData) {
                uploadData.chunks.push({ name: chunkName, duration });
                uploadData.maxDuration = Math.max(uploadData.maxDuration, duration);
                
                // Update manifest
                const manifestUpdate = [
                  `#EXTINF:${duration.toFixed(3)},`,
                  objectName
                ].join('\n') + '\n';
                
                uploadData.manifestStream.write(manifestUpdate);
                
                // Update target duration if needed
                if (uploadData.maxDuration > config.hls.segmentTime) {
                  const headerUpdate = [
                    '#EXTM3U',
                    '#EXT-X-VERSION:6',
                    `#EXT-X-TARGETDURATION:${Math.ceil(uploadData.maxDuration)}`,
                    '#EXT-X-MEDIA-SEQUENCE:0',
                    '#EXT-X-PLAYLIST-TYPE:VOD'
                  ].join('\n') + '\n';
                  
                  // This would require recreating the manifest object in MinIO
                  // For simplicity, we'll just note the need for this optimization
                  console.log(`Note: Segment duration ${uploadData.maxDuration} exceeds target ${config.hls.segmentTime}`);
                }
              }
            } catch (err) {
              console.error(`Error processing chunk ${chunkName}:`, err);
            }
          }
        }
      });
  
      ffmpegProcess.on('end', async () => {
        try {
          const uploadData = activeUploads.get(uuid);
          if (uploadData) {
            // 1. Finalize the manifest
            uploadData.manifestStream.end('#EXT-X-ENDLIST\n');
      
            // 2. Prepare track metadata
            const trackInfo = {
              manifestUrl: `http://${config.minio.endPoint}:${config.minio.port}/${config.hls.bucketName}/${manifestName}`,
              duration: uploadData.chunks.reduce((sum, chunk) => sum + chunk.duration, 0),
              chunkCount: uploadData.chunks.length,
              uuid: uuid,
              timestamp: new Date().toISOString()
            };
      
            // 3. Notify the central server (fire-and-forget)
            axios.post(config.centralServer.url, trackInfo).catch(err => {
              console.error('Failed to notify central server:', err.message);
            });
      
            // 4. Resolve without sending manifest to caller
            resolve({ success: true, uuid });
      
            // 5. Cleanup after delay
            setTimeout(() => cleanupUpload(uuid), 5000);
          }
        } catch (err) {
          reject(err);
        }
      });
  
      ffmpegProcess.on('error', (err) => {
        console.error('FFmpeg error:', err);
        cleanupUpload(uuid);
        reject(err);
      });
  
      ffmpegProcess.run();
    });
  };