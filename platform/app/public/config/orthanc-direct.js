/** @type {AppTypes.Config} */
window.config = {
  routerBasename: '/',
  extensions: [],
  modes: [],
  showStudyList: true,
  maxNumberOfWebWorkers: 4,
  showLoadingIndicator: true,
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
        dicomUploadEnabled: false,
        wadoUriRoot: 'http://localhost:8042/wado',
        qidoRoot: 'http://localhost:8042/dicom-web/',
        wadoRoot: 'http://localhost:8042/dicom-web/',
        qidoSupportsIncludeField: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        thumbnailRequestStrategy: 'fetch',
        enableStudyLazyLoad: true,
        omitQuotationForMultipartRequest: true,
        supportsFuzzyMatching: true,
        supportsWildcard: true,
        bulkDataURI: {
          enabled: true,
        },
      },
    },
  ],
};
