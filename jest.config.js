module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
  transform: {
    '^.+\\.m?js$': 'babel-jest',
  },
  transformIgnorePatterns: ['node_modules/(?!(uuid)/)'],
};
