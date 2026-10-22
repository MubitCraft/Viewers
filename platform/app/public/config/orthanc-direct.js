/** @type {AppTypes.Config} */
window.config = {
  routerBasename: '/',
  extensions: [],
  modes: [],
  showStudyList: true,
  genericViewports: {
    enabled: true,
  },
  defaultDataSourceName: 'dicomweb',
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'dicomweb',
      configuration: {
        friendlyName: 'Local Orthanc PACS (direct)',
        dicomUploadEnabled: true,
        chunkedUploadRoot: 'http://localhost:8080/api/instances/chunked-upload',
        chunkedUploadCredentials: 'same-origin',
        convertToDicomWsi: false,
        wadoUriRoot: 'http://localhost:8042/wado',
        qidoRoot: 'http://localhost:8042/dicom-web/',
        wadoRoot: 'http://localhost:8042/dicom-web/',
        qidoSupportsIncludeField: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        thumbnailRequestStrategy: 'fetch',
      },
    },
  ],
};
