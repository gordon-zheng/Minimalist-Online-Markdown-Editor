const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const socketIo = require('socket.io');
const { exec } = require('child_process');
const util = require('util');
const { spawn } = require('child_process');
const readFile = util.promisify(fs.readFile);
const execPromise = util.promisify(exec);

const app = express();
const port = process.env.PORT || 3000;

const fileTreePaths = ['/tmp', '/home/GOD'];
const containerList = ["mind_of_god", "image_of_god", "creation_of_god"];

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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
  const nodes = [];

  // Loop through each path defined in fileTreePaths
  for (const p of fileTreePaths) {
    const treeData = await getContainerFileTreeAsync(containerName, p);
    // Remove trailing slash for display if present
    const displayName = p.endsWith('/') ? p.slice(0, -1) : p;
    nodes.push({ name: displayName, type: 'directory', contents: treeData });
  }

  const fileTreeHTML = renderFileTreeHTML(nodes, 0);
  res.type('text/html').send(fileTreeHTML);
}));

// New endpoint to get file content from a Docker container
app.get('/get-docker-file', asyncHandler(async (req, res) => {
  if (!req.query.file || !req.query.file.trim() || !req.query.dockerId || !req.query.dockerId.trim()) {
    return res.status(400).send('Missing file or dockerId parameter.');
  }
  
  const filePath = req.query.file.trim();
  const dockerId = req.query.dockerId.trim();
  // Use spawn with arguments to avoid shell interpolation
  const dockerProcess = spawn('docker', ['exec', dockerId, 'cat', filePath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdoutData = '';
  let stderrData = '';
  dockerProcess.stdout.on('data', (data) => {
    stdoutData += data.toString();
  });
  dockerProcess.stderr.on('data', (data) => {
    stderrData += data.toString();
  });
  
  dockerProcess.on('close', (code) => {
    if (code !== 0) {
      console.error(`Error executing docker exec: ${stderrData}`);
      return res.status(500).send(`Error retrieving file: ${stderrData}`);
    }
    res.type('text/plain').send(stdoutData);
  });
}));

// New POST endpoint to save file content to a Docker container
app.post('/save-docker-file', asyncHandler(async (req, res) => {
  const { file, dockerId, content } = req.body;

  if (!file || !dockerId || typeof content === 'undefined') {
    return res.status(400).send('Missing file, dockerId, or content parameter.');
  }

  // Spawn the docker exec process without using a shell
  const dockerProcess = spawn('docker', ['exec', '-i', dockerId, 'sh', '-c', `cat > ${file}`], {
    stdio: ['pipe', 'ignore', 'pipe']
  });

  // Pipe the content to the docker process's stdin
  dockerProcess.stdin.write(content);
  dockerProcess.stdin.end();

  let errorData = '';
  dockerProcess.stderr.on('data', (data) => {
    errorData += data.toString();
  });

  dockerProcess.on('close', (code) => {
    if (code !== 0) {
      console.error(`Error saving file: ${errorData}`);
      return res.status(500).send(`Error saving file: ${errorData}`);
    }
    console.log(`File ${file} updated inside Docker container: ${dockerId}`);
    res.status(200).send('File saved successfully');
  });
}));

// Endpoint to return the container list
app.get('/get-container-list', asyncHandler(async (req, res) => {
  res.json(containerList);
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
