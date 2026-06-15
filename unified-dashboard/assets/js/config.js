window.SOMO_CONFIG = window.SOMO_CONFIG || {
  API_BASE: typeof window !== 'undefined' && window.location.port === '4000'
    ? ''
    : (window.REACT_APP_API_BASE || 'http://localhost:4000'),
};
