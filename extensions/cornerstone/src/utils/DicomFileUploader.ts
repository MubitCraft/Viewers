import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import { PubSubService } from '@ohif/core';

export const EVENTS = {
  PROGRESS: 'event:DicomFileUploader:progress',
};

export interface DicomFileUploaderEvent {
  fileId: number;
}

export interface DicomFileUploaderProgressEvent extends DicomFileUploaderEvent {
  percentComplete: number;
}

export enum UploadStatus {
  NotStarted,
  InProgress,
  Success,
  Failed,
  Cancelled,
}

type CancelOrFailed = UploadStatus.Cancelled | UploadStatus.Failed;

type ChunkUploadConfig = {
  chunkedUploadRoot?: string;
  chunkedUploadCredentials?: RequestCredentials;
  convertToDicomWsi?: boolean;
};

type ChunkUploadStartResponse = {
  uploadId: string;
  nextOffset: number;
};

type ChunkUploadStatusResponse = {
  status?: string;
  state?: string;
  message?: string;
  error?: string;
};

const MEBIBYTE = 1024 * 1024;
const CHUNK_SIZE = 5 * MEBIBYTE;
const MIN_CHUNK_SIZE = MEBIBYTE;
const MAX_CHUNK_SIZE = 10 * MEBIBYTE;
const CHUNK_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const STATUS_POLL_INTERVAL_MS = 1000;
const STATUS_POLL_TIMEOUT_MS = 30 * 60 * 1000;
const TIFF_EXTENSIONS = new Set(['.tif', '.tiff']);
const SUCCESS_STATES = new Set(['complete', 'completed', 'success', 'succeeded', 'imported']);
const FAILURE_STATES = new Set(['error', 'failed', 'rejected']);
const PENDING_STATES = new Set([
  'converting',
  'finalizing',
  'importing',
  'pending',
  'processing',
  'queued',
  'uploading',
]);

export class UploadRejection {
  message: string;
  status: CancelOrFailed;

  constructor(status: CancelOrFailed, message: string) {
    this.message = message;
    this.status = status;
  }
}

function getResponseError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const response = body as { message?: unknown; error?: unknown; title?: unknown };
    const message = response.message ?? response.error ?? response.title;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }

  if (typeof body === 'string' && body.length > 0) {
    try {
      return getResponseError(JSON.parse(body), status);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
    return body;
  }

  return `Upload request failed with HTTP ${status}.`;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return text;
    }
    throw error;
  }
}

function getChunkUploadUrl(root: string | undefined, uploadId?: string, action?: string): string {
  if (!root) {
    throw new Error('The chunked upload API URL is not configured.');
  }
  const normalizedRoot = root.replace(/\/+$/, '');
  const baseUrl = new URL(normalizedRoot);
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error('The chunked upload API URL must use HTTP or HTTPS.');
  }

  if (!uploadId) {
    return normalizedRoot;
  }

  const url = `${normalizedRoot}/${encodeURIComponent(uploadId)}`;
  return action ? `${url}/${action}` : url;
}

function getTiffExtension(fileName: string): string | undefined {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return TIFF_EXTENSIONS.has(extension) ? extension : undefined;
}

function isTiffFileHeader(header: Uint8Array): boolean {
  if (header.length < 4) {
    return false;
  }

  const littleEndian = header[0] === 0x49 && header[1] === 0x49;
  const bigEndian = header[0] === 0x4d && header[1] === 0x4d;

  return (
    (littleEndian && header[2] === 0x2a && header[3] === 0x00) ||
    (bigEndian && header[2] === 0x00 && header[3] === 0x2a) ||
    (littleEndian && header[2] === 0x2b && header[3] === 0x00) ||
    (bigEndian && header[2] === 0x00 && header[3] === 0x2b)
  );
}

function getSha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('This browser context does not support SHA-256 upload checksums.');
  }

  return globalThis.crypto.subtle
    .digest('SHA-256', bytes)
    .then(digest =>
      Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    );
}

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, STATUS_POLL_INTERVAL_MS);

    const onAbort = () => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Cancelled', 'AbortError'));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export default class DicomFileUploader extends PubSubService {
  private _file: File;
  private _fileId: string;
  private _dataSource;
  private _loadPromise?: Promise<void>;
  private _abortController = new AbortController();
  private _activeRequest?: XMLHttpRequest;
  private _uploadId?: string;
  private _status: UploadStatus = UploadStatus.NotStarted;
  private _percentComplete = 0;

  constructor(file: File, dataSource) {
    super(EVENTS);
    this._file = file;
    this._fileId = dicomImageLoader.wadouri.fileManager.add(file);
    this._dataSource = dataSource;
  }

  getFileId(): string {
    return this._fileId;
  }

  getFileName(): string {
    return this._file.name;
  }

  getFileSize(): number {
    return this._file.size;
  }

  cancel(): void {
    if (
      this._status === UploadStatus.Success ||
      this._isRejected() ||
      this._abortController.signal.aborted
    ) {
      return;
    }

    this._abortController.abort();
    this._activeRequest?.abort();

    if (this._uploadId) {
      const config = this._getConfig();
      const url = getChunkUploadUrl(config.chunkedUploadRoot, this._uploadId);
      void fetch(url, {
        method: 'DELETE',
        credentials: config.chunkedUploadCredentials ?? 'same-origin',
      })
        .then(async response => {
          if (!response.ok) {
            const body = await readResponseBody(response);
            console.error(getResponseError(body, response.status));
          }
        })
        .catch(error => {
          console.error('Failed to cancel the server-side chunked upload.', error);
        });
    }
  }

  getStatus(): UploadStatus {
    return this._status;
  }

  getPercentComplete(): number {
    return this._percentComplete;
  }

  async load(): Promise<void> {
    if (this._loadPromise) {
      return this._loadPromise;
    }

    this._loadPromise = this._upload().catch(reason => {
      const rejection = this._toUploadRejection(reason);
      this._status = rejection.status;
      throw rejection;
    });

    return this._loadPromise;
  }

  private async _upload(): Promise<void> {
    if (this._abortController.signal.aborted) {
      throw new UploadRejection(UploadStatus.Cancelled, 'Cancelled');
    }

    this._status = UploadStatus.InProgress;
    const config = this._getConfig();
    if (!config.chunkedUploadRoot) {
      await this._uploadWithDicomWeb();
      return;
    }

    if (this._file.size < MIN_CHUNK_SIZE) {
      throw new Error('The chunk upload API requires files of at least 1 MiB.');
    }

    const uploadRoot = getChunkUploadUrl(config.chunkedUploadRoot);
    const tiffExtension = getTiffExtension(this._file.name);
    const isTiff = Boolean(tiffExtension);

    await this._validateFile(isTiff && config.convertToDicomWsi === true);

    const startBody: { fileName: string; fileSizeBytes: number; convertToDicomWsi?: true } = {
      fileName: this._file.name,
      fileSizeBytes: this._file.size,
    };
    if (isTiff && config.convertToDicomWsi === true) {
      startBody.convertToDicomWsi = true;
    }

    const startResponse = await fetch(uploadRoot, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(startBody),
      credentials: config.chunkedUploadCredentials ?? 'same-origin',
      signal: this._abortController.signal,
    });
    const startResult = await readResponseBody(startResponse);
    if (startResponse.status !== 201) {
      throw new Error(getResponseError(startResult, startResponse.status));
    }
    if (!startResult || typeof startResult !== 'object') {
      throw new Error('The chunked upload API returned an invalid start response.');
    }

    const { uploadId, nextOffset } = startResult as ChunkUploadStartResponse;
    if (
      typeof uploadId !== 'string' ||
      uploadId.length === 0 ||
      !Number.isSafeInteger(nextOffset) ||
      nextOffset < 0 ||
      nextOffset > this._file.size
    ) {
      throw new Error('The chunked upload API returned an invalid uploadId or nextOffset.');
    }

    this._uploadId = uploadId;
    let offset = nextOffset;
    const uploadUrl = getChunkUploadUrl(config.chunkedUploadRoot, uploadId);

    while (offset < this._file.size) {
      if (this._abortController.signal.aborted) {
        throw new UploadRejection(UploadStatus.Cancelled, 'Cancelled');
      }

      const end = this._getNextChunkEnd(offset);
      const chunk = this._file.slice(offset, end);
      const checksum = await getSha256Hex(await chunk.arrayBuffer());
      await this._sendChunk(uploadUrl, offset, chunk, checksum, config);
      offset = end;
      this._setProgress(offset);
    }

    const completeResponse = await fetch(
      getChunkUploadUrl(config.chunkedUploadRoot, uploadId, 'complete'),
      {
        method: 'POST',
        credentials: config.chunkedUploadCredentials ?? 'same-origin',
        signal: this._abortController.signal,
      }
    );
    const completeResult = await readResponseBody(completeResponse);
    if (completeResponse.status !== 202) {
      throw new Error(getResponseError(completeResult, completeResponse.status));
    }

    await this._pollUntilComplete(uploadUrl, config);
    this._status = UploadStatus.Success;
    this._setProgress(this._file.size, true);
  }

  private _getConfig(): ChunkUploadConfig {
    const config = this._dataSource?.getConfig?.() as ChunkUploadConfig | undefined;
    if (!config) {
      throw new Error('The data source configuration is unavailable.');
    }
    return config;
  }

  private async _uploadWithDicomWeb(): Promise<void> {
    await this._validateFile(false);
    const dicomFile = await dicomImageLoader.wadouri.loadFileRequest(this._fileId);
    if (this._abortController.signal.aborted) {
      throw new UploadRejection(UploadStatus.Cancelled, 'Cancelled');
    }

    const request = new XMLHttpRequest();
    this._activeRequest = request;
    const abortRequest = () => request.abort();
    const onProgress = (event: ProgressEvent) => {
      if (event.lengthComputable) {
        this._setProgress(event.loaded);
      }
    };
    const onAbort = () => {
      this._abortController.signal.removeEventListener('abort', abortRequest);
      request.upload.removeEventListener('progress', onProgress);
      request.removeEventListener('abort', onAbort);
      this._activeRequest = undefined;
    };
    this._abortController.signal.addEventListener('abort', abortRequest, { once: true });
    request.upload.addEventListener('progress', onProgress);
    request.addEventListener('abort', onAbort, { once: true });

    try {
      await this._dataSource.store.dicom(dicomFile, request);
    } finally {
      this._abortController.signal.removeEventListener('abort', abortRequest);
      request.upload.removeEventListener('progress', onProgress);
      request.removeEventListener('abort', onAbort);
      this._activeRequest = undefined;
    }

    if (this._abortController.signal.aborted) {
      throw new UploadRejection(UploadStatus.Cancelled, 'Cancelled');
    }
    this._status = UploadStatus.Success;
    this._setProgress(this._file.size, true);
  }

  private async _validateFile(allowTiff: boolean): Promise<void> {
    const header = new Uint8Array(await this._file.slice(0, 132).arrayBuffer());
    const hasDicomPreamble =
      header.length >= 132 &&
      Array.from('DICM').every(
        (character, index) => character.charCodeAt(0) === header[index + 128]
      );
    if (hasDicomPreamble) {
      return;
    }

    if (allowTiff && getTiffExtension(this._file.name) && isTiffFileHeader(header)) {
      return;
    }

    throw new Error(
      allowTiff
        ? 'The file is not a valid DICOM file or a supported TIFF WSI file.'
        : 'Not a valid DICOM file.'
    );
  }

  private _getNextChunkEnd(offset: number): number {
    const remaining = this._file.size - offset;
    let chunkLength = Math.min(CHUNK_SIZE, remaining);

    if (remaining > chunkLength && remaining - chunkLength < MIN_CHUNK_SIZE) {
      chunkLength = remaining - MIN_CHUNK_SIZE;
    }

    if (chunkLength < MIN_CHUNK_SIZE || chunkLength > MAX_CHUNK_SIZE) {
      throw new Error('Unable to split the file into chunks between 1 MiB and 10 MiB.');
    }

    return offset + chunkLength;
  }

  private _sendChunk(
    url: string,
    offset: number,
    chunk: Blob,
    checksum: string,
    config: ChunkUploadConfig
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      this._activeRequest = request;
      request.open('PUT', url);
      request.withCredentials = config.chunkedUploadCredentials === 'include';
      request.setRequestHeader('Content-Type', 'application/octet-stream');
      request.setRequestHeader('Upload-Offset', String(offset));
      request.setRequestHeader('Upload-Chunk-Sha256', checksum);

      const cleanup = () => {
        request.upload.removeEventListener('progress', onProgress);
        request.removeEventListener('load', onLoad);
        request.removeEventListener('error', onError);
        request.removeEventListener('abort', onAbort);
        request.removeEventListener('timeout', onTimeout);
        if (this._activeRequest === request) {
          this._activeRequest = undefined;
        }
      };

      const onProgress = (event: ProgressEvent) => {
        if (!event.lengthComputable) {
          return;
        }
        this._setProgress(offset + event.loaded);
      };

      const onLoad = () => {
        cleanup();
        if (request.status >= 200 && request.status < 300) {
          resolve();
          return;
        }

        reject(new Error(getResponseError(request.responseText, request.status)));
      };

      const onError = () => {
        cleanup();
        reject(new Error('The chunk upload request failed.'));
      };

      const onTimeout = () => {
        cleanup();
        reject(new Error('The chunk upload request timed out.'));
      };

      const onAbort = () => {
        cleanup();
        reject(new UploadRejection(UploadStatus.Cancelled, 'Cancelled'));
      };

      request.timeout = CHUNK_REQUEST_TIMEOUT_MS;
      request.upload.addEventListener('progress', onProgress);
      request.addEventListener('load', onLoad);
      request.addEventListener('error', onError);
      request.addEventListener('timeout', onTimeout);
      request.addEventListener('abort', onAbort);

      if (this._abortController.signal.aborted) {
        request.abort();
        return;
      }

      try {
        request.send(chunk);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  private async _pollUntilComplete(uploadUrl: string, config: ChunkUploadConfig): Promise<void> {
    const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await waitForNextPoll(this._abortController.signal);
      const response = await fetch(uploadUrl, {
        credentials: config.chunkedUploadCredentials ?? 'same-origin',
        signal: this._abortController.signal,
      });
      const result = await readResponseBody(response);

      if (!response.ok) {
        throw new Error(getResponseError(result, response.status));
      }
      if (!result || typeof result !== 'object') {
        throw new Error('The chunked upload API returned an invalid status response.');
      }

      const statusResult = result as ChunkUploadStatusResponse;
      const state = (statusResult.status ?? statusResult.state)?.toLowerCase();
      if (!state) {
        throw new Error('The chunked upload status response must include a status or state.');
      }
      if (SUCCESS_STATES.has(state)) {
        return;
      }
      if (FAILURE_STATES.has(state)) {
        throw new Error(
          statusResult.message ?? statusResult.error ?? 'The server could not import this file.'
        );
      }
      if (!PENDING_STATES.has(state)) {
        throw new Error(`The chunked upload API returned an unsupported status: ${state}.`);
      }
    }

    throw new Error('Timed out while waiting for the server to finish importing the file.');
  }

  private _setProgress(uploadedBytes: number, complete = false): void {
    this._percentComplete = complete
      ? 100
      : Math.min(99, Math.floor((uploadedBytes / this._file.size) * 100));
    this._broadcastEvent(EVENTS.PROGRESS, {
      fileId: this._fileId,
      percentComplete: this._percentComplete,
    });
  }

  private _isRejected(): boolean {
    return this._status === UploadStatus.Failed || this._status === UploadStatus.Cancelled;
  }

  private _toUploadRejection(reason: unknown): UploadRejection {
    if (reason instanceof UploadRejection) {
      return reason;
    }

    if (this._abortController.signal.aborted) {
      return new UploadRejection(UploadStatus.Cancelled, 'Cancelled');
    }

    const message = reason instanceof Error ? reason.message : String(reason);
    return new UploadRejection(UploadStatus.Failed, message);
  }
}
