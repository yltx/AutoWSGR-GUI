/** GUI Python 运行时必须可导入的模块。 */
export const PYTHON_DEPENDENCY_SPECS = Object.freeze([
  {
    key: 'uvicorn',
    importName: 'uvicorn',
    packageName: 'uvicorn',
  },
  {
    key: 'fastapi',
    importName: 'fastapi',
    packageName: 'fastapi',
  },
  {
    key: 'scipy',
    importName: 'scipy._lib',
    packageName: 'scipy',
  },
  {
    key: 'requests',
    importName: 'requests',
    packageName: 'requests',
  },
  {
    key: 'beautifulSoup',
    importName: 'bs4',
    packageName: 'beautifulsoup4',
  },
  {
    key: 'maafw',
    importName: 'maa',
    packageName: 'maafw>=5.12.3,<6.0',
  },
  {
    key: 'cffi',
    importName: '_cffi_backend',
    packageName: 'cffi>=1.17,<3',
  },
  {
    key: 'rendercanvas',
    importName: 'rendercanvas',
    packageName: 'rendercanvas>=2.4,<3',
  },
  {
    key: 'wgpu',
    importName: 'wgpu.backends.wgpu_native',
    packageName: 'wgpu==0.32.0',
  },
] as const);

/** 舰船资料库更新器不由 AutoWSGR 后端依赖间接保证的包。 */
export const SHIP_LIBRARY_REQUIREMENTS: readonly string[] = Object.freeze([
  'requests>=2.32.5',
  'beautifulsoup4>=4.12.0',
]);

/** 使用 --no-deps 更新后端前必须显式安装的运行依赖。 */
export const BACKEND_RUNTIME_REQUIREMENTS: readonly string[] = Object.freeze([
  'maafw>=5.12.3,<6.0',
  'cffi>=1.17,<3',
  'rendercanvas>=2.4,<3',
  'wgpu==0.32.0',
]);
