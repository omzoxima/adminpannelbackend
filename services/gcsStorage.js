import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises'; // Missing import
 
const storage = new Storage();
const bucketName = 'run-sources-tuktuki-464514-asia-south1';
export async function uploadTextToGCS(filePath, contents, contentType, cacheControl) {
  const file = storage.bucket(bucketName).file(filePath);
  await file.save(contents, {
    contentType,
    metadata: { cacheControl },
  });
}
// Upload single file to GCS
export async function uploadToGCS(file, folder, makePublic = false) {
  const fileName = `${folder}/${uuidv4()}${path.extname(file.originalname)}`;
  const fileObj = storage.bucket(bucketName).file(fileName);
  
  // Determine proper MIME type for iOS compatibility
  let contentType = file.mimetype;
  const fileExtension = path.extname(file.originalname).toLowerCase();
  
  // Ensure MP4 files have the correct MIME type for iOS
  if (fileExtension === '.mp4') {
    contentType = 'video/mp4';
  }
  
  await fileObj.save(file.buffer, {
    metadata: {
      contentType,
      // Add cache control for better CDN performance
      cacheControl: 'public, max-age=31536000'
    }
  });
  
  // Make file public if requested
  if (makePublic) {
    await fileObj.makePublic();
    return `https://storage.googleapis.com/${bucketName}/${fileName}`;
  }
  
  return fileName;
}
 
// Upload HLS folder to GCS
export async function uploadHLSFolderToGCS(localDir, gcsPath, makePublic = false) {
  const files = await fs.readdir(localDir);
  
  await Promise.all(files.map(async (file) => {
    const filePath = path.join(localDir, file);
    const fileContent = await fs.readFile(filePath);
    const destination = `${gcsPath}${file}`;
    
    const contentType = file.endsWith('.m3u8') ? 'application/x-mpegURL' :
                      file.endsWith('.ts') ? 'video/MP2T' :
                      'application/octet-stream';
    
    const fileObj = storage.bucket(bucketName).file(destination);
    
    await fileObj.save(fileContent, {
      metadata: {
        contentType,
        cacheControl: 'public, max-age=31536000' // Cache for 1 year
      },
      resumable: false // Better for small files like HLS segments
    });
    
    // Make file public if requested
    if (makePublic) {
      await fileObj.makePublic();
    }
  }));
  
  if (makePublic) {
    return `https://storage.googleapis.com/${bucketName}/${gcsPath}playlist.m3u8`;
  }
}
 
// Generate v4 signed URL
export async function getSignedUrl(filePath, expiryMinutes = 60) {
  const file = storage.bucket(bucketName).file(filePath);

  let responseType;
  let cacheControl;

  // Correct MIME types for iOS
  if (filePath.endsWith('.m3u8')) {
    responseType = 'application/vnd.apple.mpegurl';
    cacheControl = 'public,max-age=300'; // playlist refresh every 5 min
  } else if (filePath.endsWith('.ts')) {
    responseType = 'video/mp2t';
    cacheControl = 'public,max-age=31536000'; // 1 year cache for segments
  } else {
    cacheControl = 'public,max-age=86400';
  }

  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + expiryMinutes * 60 * 1000,
    responseType,
    responseDisposition: 'inline',
    responseCacheControl: cacheControl,
  });

  return url;
}

 
// Generate v4 signed URL for upload
export async function getUploadSignedUrl(folder, extension, expiryMinutes = 15) {
  const fileName = `${folder}/${uuidv4()}${extension.startsWith('.') ? extension : '.' + extension}`;
  const file = storage.bucket(bucketName).file(fileName);
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + expiryMinutes * 60 * 1000,
   
  });
  return { url, gcsPath: fileName };
}
 
// List all .ts segment files in a GCS folder
export async function listSegmentFiles(gcsFolder) {
  console.log(`[listSegmentFiles] Querying bucket: ${bucketName}, prefix: ${gcsFolder}`);
const [files] = await storage.bucket(bucketName).getFiles({ prefix: gcsFolder });
console.log(`[listSegmentFiles] Found ${files.length} files:`, files.map(f => f.name));
 // const [files] = await storage.bucket(bucketName).getFiles({ prefix: gcsFolder });
  return files.filter(f => f.name.endsWith('.ts')).map(f => f.name);
}
export async function listSegmentFilesForTranscode(gcsFolder) {
  // Correctly parse the bucket and prefix from the full URI
  if (!gcsFolder.startsWith('gs://')) {
    throw new Error('Invalid GCS folder format. Must start with gs://');
  }
  const pathParts = gcsFolder.replace('gs://', '').split('/');
  const bucketName = pathParts.shift(); // Extracts 'bucket-name'
  const prefix = pathParts.join('/');   // Extracts 'folder/'

  console.log(`[listSegmentFiles] Querying bucket: ${bucketName}, prefix: ${prefix}`);

  // Get files using the corrected prefix
  const [files] = await storage.bucket(bucketName).getFiles({ prefix });
  console.log(`[listSegmentFiles] Found ${files.length} files in the folder.`);

  // Return the full gs:// URI for each file, which is needed for signing
  return files
    .filter(f => f.name.endsWith('.ts')) // Ensure we only get segment files
    .map(f => `gs://${bucketName}/${f.name}`);
}
// Download a file from GCS
export async function downloadFromGCS(gcsPath) {
  const [contents] = await storage.bucket(bucketName).file(gcsPath).download();
  return contents.toString();
}
// Helper: download file text from GCS
export async function downloadTextFromGCS(filePath) {
  const [contents] = await storage.bucket(bucketName).file(filePath).download();
  return contents.toString('utf8');
}
 
// Upload a file to GCS (overwrite)
/*export async function uploadTextToGCS(gcsPath, text, contentType = 'application/x-mpegURL') {
  await storage.bucket(bucketName).file(gcsPath).save(text, {
    metadata: { contentType, cacheControl: 'public, max-age=31536000' },
    resumable: false
  });
}*/
