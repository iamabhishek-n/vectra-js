const http = require('http');
const server = http.createServer((req, res) => {});
server.listen(8766, () => {
    console.log('Occupying port 8766');
});
