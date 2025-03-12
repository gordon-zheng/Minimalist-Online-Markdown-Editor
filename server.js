const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const socketIo = require('socket.io');
const { exec } = require('child_process');

const app = express();
const port = process.env.PORT || 3000;

// Add cache-control headers to force the browser to load the latest content.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

// Serve static files from the 'dist' folder without caching.
app.use(express.static(path.join(__dirname, 'dist'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

// Create an HTTP server and attach Socket.IO to it.
const server = http.createServer(app);
const io = socketIo(server);

// Endpoint to serve index.html with the markdown content inserted.
app.get('/get-markdown', (req, res) => {
  // Use query parameter 'file' to specify the markdown file, defaulting to 'test.md'
  const fileName = req.query.file || 'test.md';
  const mdFilePath = path.join(os.homedir(), fileName);

  fs.readFile(mdFilePath, 'utf8', (err, mdData) => {
    if (err) {
      console.error('Error reading markdown file:', err);
      return res.status(500).send('Error reading markdown file.');
    }

    // Adjust the path to where your index.html is located (assumed in 'dist')
    fs.readFile(path.join(__dirname, 'dist', 'index.html'), 'utf8', (err, htmlData) => {
      if (err) {
        console.error('Error reading index.html:', err);
        return res.status(500).send('Error reading index.html.');
      }

      // Replace the designated placeholder with the markdown content.
      // Also, embed the file name in the HTML (using a placeholder, e.g. %%FILE_NAME%%)
      let finalHtml = htmlData.replace('%%MARKDOWN_CONTENT%%', mdData);
      finalHtml = finalHtml.replace(/%%FILE_NAME%%/g, fileName);
      // Log the first part of the final HTML to verify replacement
      // console.log("Final HTML preview:", finalHtml.substring(0, 2000));
      res.send(finalHtml);
    });
  });
});

// Endpoint to check the file lock status using the latest OS environment variable
app.get('/lock-status', (req, res) => {
  exec('echo $LOCK_PLANNING', (err, stdout, stderr) => {
    if (err) {
      console.error('Error retrieving LOCK_PLANNING:', stderr);
      return res.status(500).json({ error: 'Error retrieving LOCK_PLANNING' });
    }
    const latestLock = stdout.trim();
    const locked = latestLock && latestLock.toLowerCase() === 'true';
    if (locked) {
      console.log('Lock detected: Editing is disabled.');
    } else {
      console.log('Lock NOT detected: Editing is enabled.');
    }
    res.json({ locked });
  });
});

// Endpoint to fetch the current markdown file content
app.get('/file-content', (req, res) => {
  const fileName = req.query.file || 'test.md';
  const filePath = path.join(os.homedir(), fileName);
  fs.readFile(filePath, 'utf8', (err, content) => {
    if (err) {
      console.error('Error reading file content:', err);
      return res.status(500).json({ error: 'Error reading file content.' });
    }
    res.json({ content });
  });
});

// Set up Socket.IO to handle dynamic file subscriptions.
io.on('connection', (socket) => {
  console.log('Client connected');

  // Expect the client to send the file name they want updates for.
  socket.on('subscribe', (fileName) => {
    console.log(`Client subscribed to file: ${fileName}`);
    socket.subscribedFile = fileName;  // Store the subscription in the socket
  });

  // Handle updates coming from the client (markdown changed event).
  socket.on('markdown changed', (newContent) => {
    const fileName = socket.subscribedFile || 'test.md';
    const filePath = path.join(os.homedir(), fileName);
    fs.writeFile(filePath, newContent, 'utf8', (err) => {
      if (err) {
        console.error(`Error writing updated markdown file for ${fileName}:`, err);
        return;
      }
      console.log(`File ${fileName} updated from client input.`);
    });
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
    // Optionally: Clean up subscriptions/watchers if needed.
  });
});

// Start the server.
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
