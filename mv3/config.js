const DEFAULT_CONFIG = Object.freeze({
  libretranslateUrl: 'http://127.0.0.1:5000/translate',
  targetLanguage: 'en',
  ocrLanguage: 'eng',
  minImageWidth: 150,
  minImageHeight: 100,
  overlayOpacity: 0.85,
  textColor: '#ffffff',
  bgColor: 'rgba(0, 0, 0, 0.7)',
  fontStack: 'Noto Sans JP, Arial, sans-serif'
});

const OCR_LANGUAGES = Object.freeze([
  'eng', 'jpn', 'kor', 'chi_sim', 'chi_tra', 'fra', 'deu',
  'spa', 'rus', 'por', 'ita', 'tha', 'vie'
]);
