const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const socketIo = require('socket.io');

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

// Dictionary to store watchers per file name.
const watchers = {};

// Set up Socket.IO to handle dynamic file subscriptions.
io.on('connection', (socket) => {
  console.log('Client connected');

  // Expect the client to send the file name they want updates for.
  socket.on('subscribe', (fileName) => {
    console.log(`Client subscribed to file: ${fileName}`);
    socket.subscribedFile = fileName;  // Store the subscription in the socket

    const filePath = path.join(os.homedir(), fileName);

    // If there's no watcher for this file yet, set one up.
    if (!watchers[fileName]) {
      watchers[fileName] = true; // Mark that a watcher is active for this file
      fs.watchFile(filePath, { interval: 1000 }, (curr, prev) => {
        console.log(`watchFile triggered for ${fileName}: curr.mtime = ${curr.mtime}, prev.mtime = ${prev.mtime}`);
        if (curr.mtime !== prev.mtime) {
          console.log(`File ${fileName} updated. Emitting update to subscribers.`);
          fs.readFile(filePath, 'utf8', (err, newContent) => {
            if (err) {
              console.error('Error reading updated markdown file:', err);
              return;
            }
            console.log(`New content for ${fileName} (first 100 chars): ${newContent.substring(0, 100)}`);
            // Emit update only to sockets that subscribed to this file.
            io.sockets.sockets.forEach((s) => {
              if (s.subscribedFile === fileName) {
                s.emit('markdown update', newContent);
                console.log(`Emitted markdown update to socket with id ${s.id}`);
              }
            });
          });
        }
      });
    }
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
