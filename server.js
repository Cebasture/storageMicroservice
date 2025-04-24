const http = require('http');
const Busboy = require('busboy');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { Client } = require('minio');
const { promisify } = require('util');
const ffmpeg = require('fluent-ffmpeg');
const ffprobe = promisify(ffmpeg.ffprobe);
const chunkingAndUpload = require('./controllers/chunkingAndUpload');
const cleanupUpload = require('./helperFunctions/cleanup');

// Configuration
const config = {
    minio: {
        endPoint: process.env.MINIO_ENDPOINT || 'localhost',
        port: parseInt(process.env.MINIO_PORT) || 9000,
        useSSL: process.env.MINIO_USE_SSL === 'true',
        accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
        secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
    },
    hls: {
        bucketName: process.env.BUCKET_NAME || 'audioChunks',
        segmentTime: 10,
        audioCodec: 'libopus',
        audioQuality: '96k'
    },
    server: {
        port: process.env.PORT || 5000,
        tempDir: path.join(__dirname, 'tmp')
    }
};

// Initialize MinIO client
const minioClient = new Client(config.minio);

// Track active uploads
const activeUploads = new Map();

// Ensure the temporary directory exists, create it if not
const ensureBucketExists = async () => {
    try {
        const exists = await minioClient.bucketExists(config.hls.bucketName);
        if (!exists) {
            await minioClient.makeBucket(config.hls.bucketName, '');
            console.log(`Created bucket: ${config.hls.bucketName}`);
        }
    } catch (err) {
        console.error('Bucket initialization failed:', err);
        process.exit(1);
    }
};

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'healthy' }));
    }

    if (req.method === 'POST' && req.url === '/upload') {
        //create a unique identifier for the upload which will be used to store the chunks and the manifest file in minio bucket
        const uuid = uuidv4();

        //creating busboy instance to parse the incoming multipart form data
        const busboy = new Busboy({ headers: req.headers });

        //initiating a temporary buffer to store the incoming file data this buffer will be used to create a readable stream for ffmpeg
        //this is necessary because ffmpeg requires a readable stream as input
        let buffer = Buffer.alloc(0);

        busboy.on('file', (_, file) => {

            //creating the buffer stream from the incoming file data  
            file.on('data', (data) => {
                buffer = Buffer.concat([buffer, data]);
            });

            //when the file stream ends, we will process the buffer and upload it to minio
            file.on('end', async () => {
                try {
                    if (buffer.length === 0) {
                        throw new Error('Empty file received');
                    }

                    await chunkingAndUpload(
                        require('stream').Readable.from(buffer),
                        uuid
                    );

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'published' }));
                } catch (err) {
                    console.error('Processing failed:', err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: err.message
                    }));
                    await cleanupUpload(uuid);
                }
            });
        });

        req.pipe(busboy);
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
});

(async () => {
    await ensureBucketExists();

    server.listen(config.server.port, () => {
        console.log(`Server running on http://localhost:${config.server.port}`);
        console.log(`HLS chunks will be stored in MinIO bucket: ${config.hls.bucketName}`);
    });

    // Cleanup on exit
    process.on('SIGINT', async () => {
        console.log('Shutting down...');
        for (const uuid of activeUploads.keys()) {
            await cleanupUpload(uuid);
        }
        process.exit();
    });
})();