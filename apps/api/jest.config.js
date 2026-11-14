module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testTimeout: 30000,
  // الملفات تتشارك قاعدة اختبار واحدة تُمحى عند بدء كل ملف، فلا تُشغَّل متوازية.
  maxWorkers: 1,
};
