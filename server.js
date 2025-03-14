const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const socketIo = require('socket.io');
const { exec } = require('child_process');
const util = require('util');
const readFile = util.promisify(fs.readFile);
const execPromise = util.promisify(exec);

const app = express();
const port = process.env.PORT || 3000;

// Helper function to retrieve the file tree from a Docker container using 'tree -J'
async function getContainerFileTreeAsync(containerName, folderPath) {
  const cmd = `docker exec ${containerName} tree -J -f ${folderPath}`;
  const { stdout } = await execPromise(cmd, { maxBuffer: 10 * 1024 * 1024 });
  let fileTree = JSON.parse(stdout);
  if (fileTree.tree && Array.isArray(fileTree.tree) && fileTree.tree.length === 1) {
    fileTree = fileTree.tree[0].contents || [];
  } else if (Array.isArray(fileTree)) {
    fileTree = fileTree[0].contents || [];
  }
  return fileTree;
}

// Recursive function to convert the file tree JSON into HTML
// We accept a depth parameter so that only top-level folders (depth 0) appear expanded by default,
// while all subdirectories (depth >= 1) are rendered closed (with a 'hidden' class).
function renderFileTreeHTML(nodes, depth = 0) {
  let html = (depth <= 1) ? '<ul>' : '<ul class="hidden">';

  nodes.forEach(node => {
    // The full path is in node.name, but we only want to display the base name.
    const displayName = path.basename(node.name);

    if (node.type === 'directory') {
      html += `
  <li>
    <span class="folder" data-file-path="${node.name}">${displayName}</span>`;
      if (node.contents && node.contents.length > 0) {
        html += renderFileTreeHTML(node.contents, depth + 1);
      } else {
        html += '<ul class="hidden"></ul>';
      }
      html += `
  </li>`;
    } else if (node.type === 'file') {
      html += `
  <li>
    <span class="file" data-file-path="${node.name}">${displayName}</span>
  </li>`;
    }
  });
  html += '</ul>';
  return html;
}

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

// Async error handler wrapper
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error('Unhandled error:', err);
      res.status(500).send('Internal Server Error.');
    });
  };
}

// Helper function to read file content
async function readFileContentAsync(fileName) {
  const filePath = path.join(os.homedir(), fileName);
  return await readFile(filePath, 'utf8');
}

// Endpoint to serve index.html with the markdown content inserted.
app.get('/get-markdown', asyncHandler(async (req, res) => {
  if (!req.query.file || !req.query.file.trim()) {
    return res.status(400).send('Missing file parameter.');
  }
  const fileName = req.query.file.trim();
  const mdData = await readFileContentAsync(fileName);
  const htmlData = await readFile(path.join(__dirname, 'dist', 'index.html'), 'utf8');
  let finalHtml = htmlData.replace('%%MARKDOWN_CONTENT%%', mdData);
  finalHtml = finalHtml.replace(/%%FILE_NAME%%/g, fileName);
  res.send(finalHtml);
}));

// New endpoint to return the raw file content
app.get('/get-file', asyncHandler(async (req, res) => {
  if (!req.query.file || !req.query.file.trim()) {
    return res.status(400).send('Missing file parameter.');
  }
  const fileName = req.query.file.trim();
  const data = await readFileContentAsync(fileName);
  res.type('text/plain').send(data);
}));

// Endpoint to check the file lock status using the latest OS environment variable
app.get('/lock-status', asyncHandler(async (req, res) => {
  const { stdout } = await execPromise('if [ -f ./system_config.sh ]; then . ./system_config.sh; fi; echo $LOCK_PLANNING');
  const latestLock = stdout.trim();
  const locked = latestLock && latestLock.toLowerCase() === 'true';
  if (locked) {
    const formattedTime = new Date().toLocaleString('en-US', { hour12: false });
    console.log(`Lock detected. Editing is disabled: ${formattedTime}:`);
  }
  res.json({ locked });
}));

// New endpoint to get rendered file tree HTML for two top-level folders: /tmp/ and /home/GOD/
app.get('/get-file-tree-html', asyncHandler(async (req, res) => {
  if (!req.query.container || !req.query.container.trim()) {
    return res.status(400).send('Missing container parameter.');
  }
  const containerName = req.query.container.trim();
  const treeData1 = await getContainerFileTreeAsync(containerName, '/tmp/');
  const treeData2 = await getContainerFileTreeAsync(containerName, '/home/GOD/');
  const node1 = { name: '/tmp', type: 'directory', contents: treeData1 };
  const node2 = { name: '/home/GOD', type: 'directory', contents: treeData2 };
  const combinedNodes = [node1, node2];
  const fileTreeHTML = renderFileTreeHTML(combinedNodes, 0);
  res.type('text/html').send(fileTreeHTML);
}));

// New endpoint to get file content from a Docker container
app.get('/get-docker-file', asyncHandler(async (req, res) => {
  if (!req.query.file || !req.query.file.trim() || !req.query.dockerId || !req.query.dockerId.trim()) {
    return res.status(400).send('Missing file or dockerId parameter.');
  }
  
  const filePath = req.query.file.trim();
  const dockerId = req.query.dockerId.trim();
  
  const cmd = `docker exec ${dockerId} cat ${filePath}`;
  console.log(`Executing command: ${cmd}`);
  const { stdout } = await execPromise(cmd, { maxBuffer: 50 * 1024 * 1024 });
  res.type('text/plain').send(stdout);
}));

// Set up Socket.IO to handle dynamic file subscriptions.
io.on('connection', (socket) => {
  console.log('Client connected');

  // Handle updates coming from the client (markdown changed event).
  socket.on('markdown changed', (data) => {
    if (!data.file || !data.file.trim()) {
      console.error('Missing file parameter in markdown changed event.');
      return;
    }
    const fileName = data.file.trim();
    const newContent = data.content;
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
