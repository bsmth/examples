import { createServer } from "http";
import { readFile, existsSync } from "fs";
import { extname } from "path";
import { server as WebSocketServer } from "websocket";

const PORT = 3000;

const mimeTypes = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

const serveStaticFile = (res, filePath, contentType) => {
  readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end("Internal Server Error");
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    }
  });
};

const handleWebRequest = (req, res) => {
  log(`Received request for ${req.url}`);
  const filePath = req.url === "/" ? "./index.html" : `.${req.url}`;
  const ext = extname(filePath);
  const contentType = mimeTypes[ext] || "application/octet-stream";

  if (!existsSync(filePath)) {
    res.writeHead(404);
    return res.end("404 Not Found");
  }

  serveStaticFile(res, filePath, contentType);
};

const webServer = createServer(handleWebRequest);

webServer.listen(PORT, () => {
  log(`Server is listening on http://localhost:${PORT}`);
});

const wsServer = new WebSocketServer({
  httpServer: webServer,
  autoAcceptConnections: false,
});

let connectionArray = [];
let nextID = Date.now();
let appendToMakeUnique = 1;

const log = (text) => {
  const time = new Date();
  console.log(`[${time.toLocaleTimeString()}] ${text}`);
};

const originIsAllowed = (origin) => true;

// Scans the list of users and see if the specified name is unique. If it is,
// return true. Otherwise, returns false. We want all users to have unique
// names.
function isUsernameUnique(name) {
  let isUnique = true;
  let i;

  for (i = 0; i < connectionArray.length; i++) {
    if (connectionArray[i].username === name) {
      isUnique = false;
      break;
    }
  }
  return isUnique;
}

// Sends a message (which is already stringified JSON) to a single
// user, given their username. We use this for the WebRTC signaling,
// and we could use it for private text messaging.
function sendToOneUser(target, msgString) {
  connectionArray.find((conn) => conn.username === target).send(msgString);
}

// Scan the list of connections and return the one for the specified
// clientID. Each login gets an ID that doesn't change during the session,
// so it can be tracked across username changes.
function getConnectionForID(id) {
  let connect = null;
  let i;

  for (i = 0; i < connectionArray.length; i++) {
    if (connectionArray[i].clientID === id) {
      connect = connectionArray[i];
      break;
    }
  }

  return connect;
}

// Builds a message object of type "userlist" which contains the names of
// all connected users. Used to ramp up newly logged-in users and,
// inefficiently, to handle name change notifications.
function makeUserListMessage() {
  let userListMsg = {
    type: "userlist",
    users: [],
  };
  let i;

  // Add the users to the list

  for (i = 0; i < connectionArray.length; i++) {
    userListMsg.users.push(connectionArray[i].username);
  }

  return userListMsg;
}

// Sends a "userlist" message to all chat members. This is a cheesy way
// to ensure that every join/drop is reflected everywhere. It would be more
// efficient to send simple join/drop messages to each user, but this is
// good enough for this simple example.
function sendUserListToAll() {
  let userListMsg = makeUserListMessage();
  let userListMsgStr = JSON.stringify(userListMsg);
  let i;

  for (i = 0; i < connectionArray.length; i++) {
    connectionArray[i].sendUTF(userListMsgStr);
  }
}

wsServer.on("request", function (request) {
  if (!originIsAllowed(request.origin)) {
    request.reject();
    log("Connection from " + request.origin + " rejected.");
    return;
  }

  // Accept the request and get a connection.

  let connection = request.accept("json", request.origin);

  // Add the new connection to our list of connections.

  log("Connection accepted from " + connection.remoteAddress + ".");
  connectionArray.push(connection);

  connection.clientID = nextID;
  nextID++;

  // Send the new client its token; it send back a "username" message to
  // tell us what username they want to use.

  let msg = {
    type: "id",
    id: connection.clientID,
  };
  connection.sendUTF(JSON.stringify(msg));

  // Set up a handler for the "message" event received over WebSocket. This
  // is a message sent by a client, and may be text to share with other
  // users, a private message (text or signaling) for one user, or a command
  // to the server.

  connection.on("message", function (message) {
    if (message.type === "utf8") {
      log("Received Message: " + message.utf8Data);

      // Process incoming data.

      let sendToClients = true;
      msg = JSON.parse(message.utf8Data);
      let connect = getConnectionForID(msg.id);

      // Take a look at the incoming object and act on it based
      // on its type. Unknown message types are passed through,
      // since they may be used to implement client-side features.
      // Messages with a "target" property are sent only to a user
      // by that name.

      switch (msg.type) {
        // Public, textual message
        case "message":
          msg.name = connect.username;
          msg.text = msg.text.replace(/(<([^>]+)>)/gi, "");
          break;

        // Username change
        case "username":
          let nameChanged = false;
          let origName = msg.name;

          // Ensure the name is unique by appending a number to it
          // if it's not; keep trying that until it works.
          while (!isUsernameUnique(msg.name)) {
            msg.name = origName + appendToMakeUnique;
            appendToMakeUnique++;
            nameChanged = true;
          }

          // If the name had to be changed, we send a "rejectusername"
          // message back to the user so they know their name has been
          // altered by the server.
          if (nameChanged) {
            let changeMsg = {
              id: msg.id,
              type: "rejectusername",
              name: msg.name,
            };
            connect.sendUTF(JSON.stringify(changeMsg));
          }

          // Set this connection's final username and send out the
          // updated user list to all users. Yeah, we're sending a full
          // list instead of just updating. It's horribly inefficient
          // but this is a demo. Don't do this in a real app.
          connect.username = msg.name;
          sendUserListToAll();
          sendToClients = false; // We already sent the proper responses
          break;
      }

      // Convert the revised message back to JSON and send it out
      // to the specified client or all clients, as appropriate. We
      // pass through any messages not specifically handled
      // in the select block above. This allows the clients to
      // exchange signaling and other control objects unimpeded.

      if (sendToClients) {
        const msgString = JSON.stringify(msg);

        if (msg.target && msg.target.length !== 0) {
          sendToOneUser(msg.target, msgString);
        } else {
          for (const connection of connectionArray) {
            connection.send(msgString);
          }
        }
      }
    }
  });

  // Handle the WebSocket "close" event; this means a user has logged off
  // or has been disconnected.
  connection.on("close", function (reason, description) {
    // First, remove the connection from the list of connections.
    connectionArray = connectionArray.filter(function (el, idx, ar) {
      return el.connected;
    });

    // Now send the updated user list. Again, please don't do this in a
    // real application. Your users won't like you very much.
    sendUserListToAll();

    // Build and output log output for close information.

    let logMessage =
      "Connection closed: " + connection.remoteAddress + " (" + reason;
    if (description !== null && description.length !== 0) {
      logMessage += ": " + description;
    }
    logMessage += ")";
    log(logMessage);
  });
});
