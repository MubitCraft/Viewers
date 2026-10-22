jest.mock('@cornerstonejs/dicom-image-loader', () => ({
  __esModule: true,
  default: {
    wadouri: {
      fileManager: {
        add: jest.fn(() => 'local-file-id'),
      },
      loadFileRequest: jest.fn(async () => {
        const dicom = new Uint8Array(132);
        dicom.set([68, 73, 67, 77], 128);
        return dicom.buffer;
      }),
    },
  },
}));

jest.mock('@ohif/core', () => ({
  PubSubService: class {
    private subscribers = new Map<string, Array<(event: unknown) => void>>();

    constructor() {}

    subscribe(eventName: string, callback: (event: unknown) => void) {
      const callbacks = this.subscribers.get(eventName) ?? [];
      callbacks.push(callback);
      this.subscribers.set(eventName, callbacks);
      return {
        unsubscribe: () => {
          this.subscribers.set(
            eventName,
            (this.subscribers.get(eventName) ?? []).filter(item => item !== callback)
          );
        },
      };
    }

    protected _broadcastEvent(eventName: string, event: unknown) {
      this.subscribers.get(eventName)?.forEach(callback => callback(event));
    }
  },
}));

import DicomFileUploader, { UploadRejection, UploadStatus } from './DicomFileUploader';

const MEBIBYTE = 1024 * 1024;

class MockXMLHttpRequest extends EventTarget {
  static requests: MockXMLHttpRequest[] = [];
  upload = new EventTarget();
  headers: Record<string, string> = {};
  method: string;
  url: string;
  status = 0;
  responseText = '';
  withCredentials = false;
  body: Blob;

  constructor() {
    super();
    MockXMLHttpRequest.requests.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: Blob) {
    this.body = body;
    this.status = 204;

    const progressEvent = new Event('progress');
    Object.assign(progressEvent, {
      lengthComputable: true,
      loaded: body.size,
      total: body.size,
    });
    this.upload.dispatchEvent(progressEvent);
    this.dispatchEvent(new Event('load'));
  }

  abort() {
    this.dispatchEvent(new Event('abort'));
  }
}

function makeResponse(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

function makeDicomFile(size: number): File {
  return {
    name: 'scan.dcm',
    size,
    slice(start: number, end: number) {
      const length = end - start;
      return {
        size: length,
        arrayBuffer: async () => {
          const bytes = new Uint8Array(length);
          if (start === 0 && end >= 132) {
            bytes.set([68, 73, 67, 77], 128);
          }
          return bytes.buffer;
        },
      } as Blob;
    },
  } as File;
}

function makeTiffFile(size: number): File {
  return {
    name: 'slide.tiff',
    size,
    slice(start: number, end: number) {
      const length = end - start;
      return {
        size: length,
        arrayBuffer: async () => {
          const bytes = new Uint8Array(length);
          if (start === 0 && end >= 4) {
            bytes.set([0x49, 0x49, 0x2a, 0x00]);
          }
          return bytes.buffer;
        },
      } as Blob;
    },
  } as File;
}

describe('DicomFileUploader chunk transport', () => {
  const originalFetch = globalThis.fetch;
  const originalXMLHttpRequest = globalThis.XMLHttpRequest;
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let fetchMock: jest.Mock;

  beforeEach(() => {
    MockXMLHttpRequest.requests = [];
    fetchMock = jest.fn();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      configurable: true,
      value: MockXMLHttpRequest,
    });
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        subtle: {
          digest: jest.fn(async () => new Uint8Array(32).buffer),
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: originalFetch,
    });
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      configurable: true,
      value: originalXMLHttpRequest,
    });
    if (originalCryptoDescriptor) {
      Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    }
  });

  it('uploads bounded chunks sequentially, then finalizes and polls status', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(201, { uploadId: 'upload/1', nextOffset: 0 }))
      .mockResolvedValueOnce(makeResponse(202))
      .mockResolvedValueOnce(makeResponse(200, { status: 'completed' }));

    const file = makeDicomFile(6 * MEBIBYTE);
    const dataSource = {
      getConfig: () => ({
        chunkedUploadRoot: 'http://localhost:8080/api/instances/chunked-upload',
      }),
    };
    const uploader = new DicomFileUploader(file, dataSource);

    await uploader.load();

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/api/instances/chunked-upload');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      fileName: 'scan.dcm',
      fileSizeBytes: 6 * MEBIBYTE,
    });
    expect(MockXMLHttpRequest.requests).toHaveLength(2);
    expect(MockXMLHttpRequest.requests.map(request => request.body.size)).toEqual([
      5 * MEBIBYTE,
      MEBIBYTE,
    ]);
    expect(MockXMLHttpRequest.requests.map(request => request.headers['Upload-Offset'])).toEqual([
      '0',
      String(5 * MEBIBYTE),
    ]);
    expect(
      MockXMLHttpRequest.requests.every(request =>
        /^[a-f0-9]{64}$/.test(request.headers['Upload-Chunk-Sha256'])
      )
    ).toBe(true);
    expect(MockXMLHttpRequest.requests[0].url).toBe(
      'http://localhost:8080/api/instances/chunked-upload/upload%2F1'
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://localhost:8080/api/instances/chunked-upload/upload%2F1/complete'
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      'http://localhost:8080/api/instances/chunked-upload/upload%2F1'
    );
    expect(uploader.getStatus()).toBe(UploadStatus.Success);
    expect(uploader.getPercentComplete()).toBe(100);
  });

  it('reports the backend 413 response instead of treating an oversized import as successful', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(201, { uploadId: 'upload-2', nextOffset: 0 }))
      .mockResolvedValueOnce(
        makeResponse(413, { message: 'DICOM file exceeds the import limit.' })
      );

    const uploader = new DicomFileUploader(makeDicomFile(MEBIBYTE), {
      getConfig: () => ({
        chunkedUploadRoot: 'http://localhost:8080/api/instances/chunked-upload',
      }),
    });

    await expect(uploader.load()).rejects.toEqual(
      new UploadRejection(UploadStatus.Failed, 'DICOM file exceeds the import limit.')
    );
    expect(uploader.getStatus()).toBe(UploadStatus.Failed);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the existing DICOMweb STOW upload path when no chunk API is configured', async () => {
    const dicomFile = makeDicomFile(512);
    const dataSource = {
      getConfig: () => ({}),
      store: {
        dicom: jest.fn(async () => undefined),
      },
    };
    const uploader = new DicomFileUploader(dicomFile, dataSource);

    await uploader.load();

    expect(dataSource.store.dicom).toHaveBeenCalledWith(expect.any(ArrayBuffer), expect.anything());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploader.getStatus()).toBe(UploadStatus.Success);
  });

  it('requests TIFF-to-DICOM WSI conversion only when enabled in the data-source config', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(201, { uploadId: 'wsi-upload', nextOffset: 0 }))
      .mockResolvedValueOnce(makeResponse(202))
      .mockResolvedValueOnce(makeResponse(200, { state: 'imported' }));

    const uploader = new DicomFileUploader(makeTiffFile(MEBIBYTE), {
      getConfig: () => ({
        chunkedUploadRoot: 'http://localhost:8080/api/instances/chunked-upload',
        convertToDicomWsi: true,
      }),
    });

    await uploader.load();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      fileName: 'slide.tiff',
      fileSizeBytes: MEBIBYTE,
      convertToDicomWsi: true,
    });
    expect(uploader.getStatus()).toBe(UploadStatus.Success);
  });
});
