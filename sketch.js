// === PERFORMANCE OPTIMIZED VERSION ===
// Global variables with optimized defaults
let bodyPose;
let video;
let poses = [];
let connections;
let balls = [];
let score = 0;
let containerWidth, containerHeight;
let isModelReady = false;
let lastBallCreationTime = 0;
let debugMode = false; // Set to false by default for better performance

// Game state variables
let gameState = "waiting"; // waiting, calibrating, playing, gameOver
let showInstructions = true;
let calibrationTime = 0;
let calibrationDuration = 2000; // 2 seconds of calibration
let startGestureDetected = false;
let gestureProgressBar = 0;

// Level variables
let currentLevel = 1;
let levelBallCount = 5;
let levelSpeed = 1;
let levelBallSize = 40;

// Camera permission and UI state variables
let cameraPermissionState = "waiting"; // waiting, granted, denied, error

// Optimized position history for smoothing (smaller history length for less memory use)
const HISTORY_LENGTH = 5; // Reduced from 8
let positionHistory = {
  leftWrist: [],
  rightWrist: []
};

// Particle and visual effects
let particles = [];
let scoreTexts = [];
const MAX_PARTICLES = 30; // Limit maximum particles for performance
const MAX_SCORE_TEXTS = 15; // Limit score text elements

// Throttling variables for optimization
let lastRenderTime = 0;
const RENDER_THROTTLE = 0; // No throttling by default, increase if needed (e.g., 16 for 60fps cap)
let lastTouchDesignerUpdateTime = 0;
const TD_UPDATE_INTERVAL = 33; // ~30fps update rate to TouchDesigner

// Create a global object to expose tracking data to TouchDesigner
window.trackingData = {
  wrists: { left: { x: 0, y: 0, active: false }, right: { x: 0, y: 0, active: false } },
  keypoints: [],
  score: 0,
  level: 1,
  balls: [],
  modelStatus: "initializing",
  gameState: gameState
};

// TouchDesigner integration variables
let isTouchDesignerConnected = false;
let useTouchDesignerSensors = false;
let statusDiv;

// Auto-connection variables
let touchDesignerAutoConnect = true;
let touchDesignerReconnectAttempts = 0;
let touchDesignerCheckInterval;
let touchDesignerLastPing = 0;
let touchDesignerWebSocket = null;
let webSocketConnected = false;
let touchDesignerPort = 7000;

// Check if ml5 library is available
let ml5Available = (typeof ml5 !== 'undefined');

// ---------------- TOUCHDESIGNER CONNECTION FUNCTIONS ----------------

// Create status display - SIMPLIFIED
function createStatusDisplay() {
  statusDiv = document.createElement('div');
  statusDiv.style.position = 'absolute';
  statusDiv.style.bottom = '10px';
  statusDiv.style.left = '10px';
  statusDiv.style.background = 'rgba(0,0,0,0.5)';
  statusDiv.style.color = 'white';
  statusDiv.style.padding = '5px';
  statusDiv.style.fontFamily = 'monospace';
  statusDiv.style.zIndex = '1000';
  statusDiv.id = 'statusDiv';
  document.body.appendChild(statusDiv);
}

// Update status text
function updateStatusText(message) {
  console.log(message);
  
  if (document.getElementById('statusDiv')) {
    document.getElementById('statusDiv').innerHTML = message;
  }
}

// TouchDesigner calls this to establish connection
window.touchDesignerConnect = function() {
  isTouchDesignerConnected = true;
  updateStatusText("TouchDesigner connected! ✓");
  return "Connection successful";
};

// TouchDesigner calls this to get tracking data - OPTIMIZED to send less data
window.getTrackingData = function() {
  // Only include essential data to reduce payload size
  const essentialData = {
    wrists: window.trackingData.wrists,
    score: window.trackingData.score,
    level: window.trackingData.level,
    gameState: window.trackingData.gameState,
    // Only send ball positions if they've changed since last update
    balls: window.trackingData.balls.map(ball => ({
      x: Math.round(ball.x), // Round to integers to reduce data size
      y: Math.round(ball.y),
      touched: ball.touched
    }))
  };
  
  return JSON.stringify(essentialData);
};

// TouchDesigner calls this to set wrist positions from external motion sensors
window.setWristFromTouchDesigner = function(wrist, x, y, active = true) {
  useTouchDesignerSensors = true; // Switch to TouchDesigner mode
  
  if (wrist === "left") {
    // Apply smoothing with less computation
    const smoothed = smoothPosition(x, y, 'leftWrist');
    window.trackingData.wrists.left.x = smoothed.x;
    window.trackingData.wrists.left.y = smoothed.y;
    window.trackingData.wrists.left.active = active;
  } else if (wrist === "right") {
    // Apply smoothing with less computation
    const smoothed = smoothPosition(x, y, 'rightWrist');
    window.trackingData.wrists.right.x = smoothed.x;
    window.trackingData.wrists.right.y = smoothed.y;
    window.trackingData.wrists.right.active = active;
  }
  
  // Check for start gesture if in waiting state
  if (gameState === "waiting") {
    checkStartGesture();
  }
  
  return "Wrist position set: " + wrist;
};

// Set a specific keypoint from TouchDesigner
window.setKeypointFromTouchDesigner = function(part, x, y, confidence = 0.8) {
  // Find if this keypoint already exists
  let found = false;
  
  for (let i = 0; i < window.trackingData.keypoints.length; i++) {
    if (window.trackingData.keypoints[i].part === part) {
      window.trackingData.keypoints[i].x = x;
      window.trackingData.keypoints[i].y = y;
      window.trackingData.keypoints[i].confidence = confidence;
      found = true;
      break;
    }
  }
  
  // If not found, add it
  if (!found) {
    window.trackingData.keypoints.push({
      part: part,
      x: x,
      y: y,
      confidence: confidence
    });
  }
  
  return "Keypoint set: " + part;
};

// Reset to browser-based pose detection
window.useBuiltInPoseDetection = function() {
  // Only allow if ml5 is available
  if (!ml5Available) {
    updateStatusText("Cannot use browser detection - ml5 library not available");
    return "Error: ml5 library not available";
  }
  
  useTouchDesignerSensors = false;
  updateStatusText("Using browser pose detection");
  return "Switched to built-in pose detection";
};

// Force start the game from TouchDesigner
window.forceStartGame = function() {
  if (gameState === "waiting") {
    startGame();
  }
  return "Game started";
};

// Initialize WebSocket connection to TouchDesigner - OPTIMIZED for reliability
function initWebSocketConnection() {
  try {
    // Close existing connection if there is one
    if (touchDesignerWebSocket && touchDesignerWebSocket.readyState !== WebSocket.CLOSED) {
      touchDesignerWebSocket.close();
    }
    
    // Create new WebSocket connection
    const wsUrl = `ws://localhost:${touchDesignerPort}`;
    touchDesignerWebSocket = new WebSocket(wsUrl);
    
    touchDesignerWebSocket.onopen = function() {
      console.log("WebSocket connection established to TouchDesigner!");
      webSocketConnected = true;
      isTouchDesignerConnected = true;
      updateStatusText("TouchDesigner WebSocket connected on port " + touchDesignerPort);
      touchDesignerReconnectAttempts = 0;
      
      // Send initial data to confirm connection - SMALLER PAYLOAD
      sendWebSocketData({
        type: "connection",
        status: "connected",
        dimensions: [containerWidth, containerHeight]
      });
    };
    
    touchDesignerWebSocket.onmessage = function(event) {
      try {
        const message = JSON.parse(event.data);
        handleTouchDesignerMessage(message);
      } catch (e) {
        console.error("Error parsing TouchDesigner message:", e);
      }
    };
    
    touchDesignerWebSocket.onclose = function() {
      webSocketConnected = false;
      if (touchDesignerAutoConnect && touchDesignerReconnectAttempts < 5) { // Reduced reconnect attempts
        touchDesignerReconnectAttempts++;
        updateStatusText(`TouchDesigner WebSocket disconnected. Retrying...`);
        setTimeout(initWebSocketConnection, 2000);
      }
    };
    
    touchDesignerWebSocket.onerror = function(error) {
      console.error("WebSocket error:", error);
    };
  } catch (e) {
    console.error("Failed to initialize WebSocket:", e);
  }
}

// Send data to TouchDesigner via WebSocket - OPTIMIZED to send less frequently
function sendWebSocketData(data) {
  if (webSocketConnected && touchDesignerWebSocket && 
      touchDesignerWebSocket.readyState === WebSocket.OPEN) {
    try {
      // Only send data if it's essential or if enough time has passed
      const currentTime = millis();
      if (data.type === "ping" || data.type === "connection" || 
          data.type === "gameStateChange" || data.type === "levelChange" ||
          data.type === "gameOver" || data.type === "ballHit" ||
          currentTime - lastTouchDesignerUpdateTime > TD_UPDATE_INTERVAL) {
        
        // Add timestamp only if really needed
        if (["ballHit", "levelChange", "gameOver"].includes(data.type)) {
          data.timestamp = currentTime;
        }
        
        touchDesignerWebSocket.send(JSON.stringify(data));
        touchDesignerLastPing = currentTime;
        lastTouchDesignerUpdateTime = currentTime;
        return true;
      }
    } catch (e) {
      console.error("Error sending WebSocket data:", e);
      return false;
    }
  }
  return false;
}

// Enhanced function to push data to TouchDesigner - OPTIMIZED for less frequent updates
function pushDataToTouchDesigner() {
  const currentTime = millis();
  
  // Only update if enough time has passed since last update
  if (currentTime - lastTouchDesignerUpdateTime > TD_UPDATE_INTERVAL) {
    // Create a custom event that TouchDesigner can listen for
    const event = new CustomEvent('trackingDataUpdated', { 
      detail: window.trackingData 
    });
    window.dispatchEvent(event);
    
    // Use WebSocket if available (more reliable)
    if (webSocketConnected) {
      sendWebSocketData({
        type: "trackingUpdate",
        data: {
          wrists: window.trackingData.wrists,
          score: window.trackingData.score,
          gameState: window.trackingData.gameState
        }
      });
    }
    
    lastTouchDesignerUpdateTime = currentTime;
  }
  
  // Ping TouchDesigner less frequently to keep connection alive
  if (webSocketConnected && currentTime - touchDesignerLastPing > 3000) {
    sendWebSocketData({
      type: "ping"
    });
  }
}

// Handle incoming messages from TouchDesigner - SIMPLIFIED
function handleTouchDesignerMessage(message) {
  // Process different message types
  switch (message.type) {
    case "ping":
      // Respond to keep-alive pings
      sendWebSocketData({ type: "pong" });
      break;
      
    case "setWrist":
      // Handle direct wrist position updates
      if (message.data && message.data.wrist) {
        window.setWristFromTouchDesigner(
          message.data.wrist,
          message.data.x,
          message.data.y,
          message.data.active
        );
      }
      break;
      
    case "config":
      // Handle configuration updates
      if (message.data) {
        if (message.data.useTouchDesignerSensors !== undefined) {
          useTouchDesignerSensors = message.data.useTouchDesignerSensors;
        }
        if (message.data.debugMode !== undefined) {
          debugMode = message.data.debugMode;
        }
      }
      break;
    
    case "startGame":
      // Force start the game from TouchDesigner
      startGame();
      break;
      
    case "resetGame":
      // Reset the game
      resetGame();
      break;
  }
}

// Check for TouchDesigner connection using window properties
function checkTouchDesignerConnection() {
  // Skip check if already connected via WebSocket
  if (webSocketConnected) return;
  
  // Check if TouchDesigner has set a special property
  if (window.touchDesignerLinked) {
    if (!isTouchDesignerConnected) {
      isTouchDesignerConnected = true;
      window.touchDesignerConnect(); // Call the existing connect function
    }
  } else if (touchDesignerAutoConnect) {
    // Create a global object that TouchDesigner can use to confirm connection
    window.touchDesignerLinked = false;
    
    // Use postMessage as well to try to communicate with TouchDesigner
    try {
      window.parent.postMessage({ type: "TOUCHDESIGNER_CONNECT_REQUEST" }, "*");
    } catch (e) {
      // Ignore errors, parent might not exist or be same origin
    }
    
    // Expose a function that TouchDesigner can call to establish connection
    window.declareTouchDesignerPresence = function() {
      window.touchDesignerLinked = true;
      return "TouchDesigner presence declared";
    };
  }
}

// Auto-connection function that tries multiple methods to connect
window.initTouchDesignerConnection = function() {
  updateStatusText("Initializing TouchDesigner connection...");
  
  // First attempt WebSocket connection if supported
  if (window.WebSocket) {
    initWebSocketConnection();
  }
  
  // Also set up the polling mechanism for traditional connection
  touchDesignerCheckInterval = setInterval(checkTouchDesignerConnection, 1000);
  
  // Expose auto-connection toggle for TouchDesigner
  window.enableTouchDesignerAutoConnect = function(enable) {
    touchDesignerAutoConnect = enable;
    updateStatusText("TouchDesigner auto-connect: " + (enable ? "ENABLED" : "DISABLED"));
    return "Auto-connect " + (enable ? "enabled" : "disabled");
  };
  
  // Expose port configuration
  window.setTouchDesignerPort = function(port) {
    touchDesignerPort = port;
    updateStatusText("TouchDesigner port set to: " + port);
    // Reinitialize the connection with the new port
    if (webSocketConnected) {
      touchDesignerWebSocket.close();
      setTimeout(initWebSocketConnection, 500);
    }
    return "Port set to " + port;
  };
};

// Function for position smoothing - OPTIMIZED FOR SPEED
function smoothPosition(newX, newY, keypointType) {
  if (!positionHistory[keypointType]) {
    positionHistory[keypointType] = [];
  }
  
  // Add new position to history
  positionHistory[keypointType].push({x: newX, y: newY});
  
  // Keep history at fixed length
  if (positionHistory[keypointType].length > HISTORY_LENGTH) {
    positionHistory[keypointType].shift();
  }
  
  // Calculate smoothed position with simpler weighted averaging
  let smoothedX = 0;
  let smoothedY = 0;
  let totalWeight = 0;
  const historyLength = positionHistory[keypointType].length;
  
  for (let i = 0; i < historyLength; i++) {
    // Linear weighting - simpler and faster than exponential
    let weight = i + 1;
    smoothedX += positionHistory[keypointType][i].x * weight;
    smoothedY += positionHistory[keypointType][i].y * weight;
    totalWeight += weight;
  }
  
  return {
    x: smoothedX / totalWeight,
    y: smoothedY / totalWeight
  };
}

// ---------------- GAME FUNCTIONS ----------------

// Setup function - OPTIMIZED
function setup() {
  // Create status display first
  createStatusDisplay();
  
  // Get container dimensions
  containerWidth = windowWidth;
  containerHeight = windowHeight;
  
  // Create canvas that fills the TouchDesigner container
  createCanvas(containerWidth, containerHeight);
  
  // Check if ml5 is available and notify user
  if (!ml5Available) {
    useTouchDesignerSensors = true;
    window.trackingData.modelStatus = "ready (TD only)";
  }
  
  // Start camera immediately
  startCamera();
  
  // Create initial balls
  createInitialBalls();
  
  // Set frame rate - 60fps is standard, adjust if needed
  frameRate(60);
  
  // Initialize TouchDesigner auto-connection
  window.initTouchDesignerConnection();
}

// Function to start the camera with permission
function startCamera() {
  try {
    video = createCapture({
      video: {
        width: containerWidth,
        height: containerHeight,
        facingMode: "user" // Front camera
      }
    }, 
    // Callback for when video is ready
    function(stream) {
      cameraPermissionState = "granted";
      
      // Initialize pose detection if not using TouchDesigner sensors
      if (!useTouchDesignerSensors && ml5Available) {
        initializePoseDetection();
      }
    });
    
    video.elt.addEventListener('error', function(e) {
      cameraPermissionState = "error";
    });
    
    video.size(containerWidth, containerHeight);
    video.hide();
  } catch (e) {
    cameraPermissionState = "error";
  }
}

// Initialize pose detection with ml5.js - OPTIMIZED FOR PERFORMANCE
function initializePoseDetection() {
  if (!ml5Available) {
    updateStatusText("ML5 not available. Using TouchDesigner for motion sensing.");
    return;
  }
  
  // Use much lower thresholds for better performance
  bodyPose = ml5.bodyPose({
    architecture: 'MobileNetV1',
    imageScaleFactor: 0.3,     // Lower for faster processing
    outputStride: 16,          // Higher for faster processing
    flipHorizontal: true,
    minConfidence: 0.2,        // Higher threshold to reduce noise
    maxPoseDetections: 1,      // Only detect one pose for better performance
    scoreThreshold: 0.5,       // Higher threshold for better performance
    nmsRadius: 30,             // Higher for faster processing
    detectionType: 'single',   // Only detect one pose
    multiplier: 0.5            // Lower for faster processing
  }, modelReady);
}

function modelReady() {
  isModelReady = true;
  window.trackingData.modelStatus = "ready"; // Update model status
  
  // Only start detection if we're not using TouchDesigner sensors
  if (!useTouchDesignerSensors && ml5Available) {
    // Start detection with explicit callback
    bodyPose.detectStart(video, gotPoses);
    
    // Get skeleton connections
    connections = bodyPose.getSkeleton();
  }
}

// Callback function for when the model returns pose data
function gotPoses(results) {
  // Only update poses from browser if we're not using TouchDesigner sensors
  if (!useTouchDesignerSensors) {
    poses = results;
    
    // Update trackingData for TouchDesigner
    if (poses.length > 0) {
      // Reset wrist activity flags
      window.trackingData.wrists.left.active = false;
      window.trackingData.wrists.right.active = false;
      
      // Only extract keypoints we need rather than all keypoints
      const essentialKeypoints = ['leftWrist', 'rightWrist'];
      
      // Extract only essential keypoints with confidence
      poses[0].keypoints.forEach((keypoint, index) => {
        if (essentialKeypoints.includes(keypoint.part) || index === 9 || index === 10) {
          // Special handling for wrists (used for interactions)
          if ((index === 9 || keypoint.part === 'leftWrist') && keypoint.confidence > 0.2) {
            // Apply smoothing
            const smoothed = smoothPosition(keypoint.x, keypoint.y, 'leftWrist');
            window.trackingData.wrists.left.x = smoothed.x;
            window.trackingData.wrists.left.y = smoothed.y;
            window.trackingData.wrists.left.active = true;
          }
          if ((index === 10 || keypoint.part === 'rightWrist') && keypoint.confidence > 0.2) {
            // Apply smoothing
            const smoothed = smoothPosition(keypoint.x, keypoint.y, 'rightWrist');
            window.trackingData.wrists.right.x = smoothed.x;
            window.trackingData.wrists.right.y = smoothed.y;
            window.trackingData.wrists.right.active = true;
          }
        }
      });
      
      // Check for start gesture
      if (gameState === "waiting") {
        checkStartGesture();
      }
    }
  }
}

// IMPROVED: Check if the start gesture has been detected - SIMPLIFIED
function checkStartGesture() {
  // Only check if we're waiting to start the game
  if (gameState !== "waiting") return;
  
  // Get hand positions
  const leftHand = window.trackingData.wrists.left;
  const rightHand = window.trackingData.wrists.right;
  
  // Lower the threshold to make it easier to trigger (60% from top)
  const heightThreshold = height * 0.6;
  
  // More lenient gesture detection - just need one hand above the threshold
  const isHandRaised = 
    (leftHand.active && leftHand.y < heightThreshold) || 
    (rightHand.active && rightHand.y < heightThreshold);
  
  // Update start gesture detection
  startGestureDetected = isHandRaised;
  
  // If gesture detected, start calibration
  if (startGestureDetected) {
    if (calibrationTime === 0) {
      // Start calibration
      calibrationTime = millis();
    } else {
      // Check if calibration is complete
      const elapsedTime = millis() - calibrationTime;
      gestureProgressBar = elapsedTime / calibrationDuration;
      
      if (elapsedTime >= calibrationDuration) {
        // Calibration complete, start the game
        startGame();
      }
    }
  } else {
    // Reset calibration if gesture is lost
    if (calibrationTime !== 0) {
      calibrationTime = 0;
      gestureProgressBar = 0;
    }
  }
}

// Start the game
function startGame() {
  gameState = "playing";
  window.trackingData.gameState = gameState;
  showInstructions = false;
  calibrationTime = 0;
  gestureProgressBar = 0;
  
  // Reset score
  score = 0;
  
  // Clear existing balls and create new ones
  balls = [];
  createInitialBalls();
  
  // Force create at least one ball that's visible immediately
  for (let i = 0; i < 3; i++) {
    createImmediateBall();
  }
  
  // Notify TouchDesigner that the game has started
  if (webSocketConnected) {
    sendWebSocketData({
      type: "gameStateChange",
      state: "playing"
    });
  }
}

// Reset the game to waiting state
function resetGame() {
  gameState = "waiting";
  window.trackingData.gameState = gameState;
  showInstructions = true;
  calibrationTime = 0;
  gestureProgressBar = 0;
  score = 0;
  currentLevel = 1;
  
  // Clear and recreate balls
  balls = [];
  createInitialBalls();
  
  // Notify TouchDesigner of game reset
  if (webSocketConnected) {
    sendWebSocketData({
      type: "gameStateChange",
      state: "waiting"
    });
  }
}

// Create initial set of balls
function createInitialBalls() {
  for (let i = 0; i < 5; i++) {
    balls.push({
      x: random(20, containerWidth - 20),
      y: random(-100, -20), // Stagger the starting positions
      size: random(30, 50),
      speed: random(1, 4),
      touched: false,
      color: color(0, 0, 139, 220) // Add transparency for a nicer look
    });
  }
  lastBallCreationTime = millis();
  
  // Update trackingData with initial ball positions
  updateTrackingDataBalls();
}

// Create a ball that's immediately visible on screen
function createImmediateBall() {
  balls.push({
    x: random(50, width - 50),
    y: random(100, height - 200), // Position somewhere in the middle of screen
    size: random(40, 60),
    speed: random(1, 3),
    touched: false,
    color: color(0, 0, 139, 220) // Original color with alpha
  });
  
  // Update tracking data
  updateTrackingDataBalls();
}

// Create a new ball at a random x position at the top of the screen
function createNewBall() {
  balls.push({
    x: random(20, width - 20),
    y: -20,
    size: random(30, 50),
    speed: random(1, 4),
    touched: false,
    color: color(0, 0, 139, 220) // Original color with alpha
  });
  lastBallCreationTime = millis();
  
  // Update tracking data
  updateTrackingDataBalls();
}

// Update the global trackingData object with current ball positions - OPTIMIZED
function updateTrackingDataBalls() {
  // Only send essential ball data (position, touched state)
  // Round positions to integers to reduce data size
  window.trackingData.balls = balls.map(ball => ({
    x: Math.round(ball.x),
    y: Math.round(ball.y),
    touched: ball.touched
  }));
}

// Improved ball collision detection with better error handling and SIMPLIFIED
function checkBallCollision(x, y) {
  // Skip if coordinates invalid
  if (isNaN(x) || isNaN(y)) return;
  
  for (let i = 0; i < balls.length; i++) {
    let ball = balls[i];
    
    // Calculate distance between keypoint and ball using squared distance for speed
    let dx = x - ball.x;
    let dy = y - ball.y;
    let distanceSq = dx * dx + dy * dy;
    
    // MUCH more generous interaction radius
    const interactionRadius = ball.size / 2 + 60; // Very large radius for easier interaction
    const interactionRadiusSq = interactionRadius * interactionRadius;
    
    if (distanceSq < interactionRadiusSq && !ball.touched) {
      ball.touched = true;
      
      // Only increment score if we're in playing state
      if (gameState === "playing") {
        score++;
        
        // Add visual feedback text
        if (scoreTexts.length < MAX_SCORE_TEXTS) {
          createScoreText(ball.x, ball.y);
        }
      }
      
      // Simpler visual feedback - less particles for better performance
      ball.size *= 1.5; // Reduced from 1.8 for better performance
      ball.speed *= 1.5; // Reduced from 2 for better performance
      
      // Create fewer particles for performance
      const particleCount = Math.min(10, MAX_PARTICLES - particles.length);
      for (let j = 0; j < particleCount; j++) {
        createParticle(ball.x, ball.y);
      }
      
      // Update tracking data
      updateTrackingDataBalls();
      
      // Notify TouchDesigner of successful hit
      if (webSocketConnected) {
        sendWebSocketData({
          type: "ballHit",
          position: { x: Math.round(ball.x), y: Math.round(ball.y) },
          score: score
        });
      }
    }
  }
}

// Update balls - OPTIMIZED for better performance
function updateBalls() {
  // Remove balls that have fallen off the bottom
  balls = balls.filter(ball => ball.y < height + ball.size);
  
  // Only add new balls if we're in playing state
  if (gameState === "playing") {
    // Add new balls at a controlled rate
    const currentTime = millis();
    if ((currentTime - lastBallCreationTime > 1000 || balls.length < 5) && balls.length < 15) {
      createNewBall();
    }
    
    // Make sure there are always at least 3 balls on screen
    if (balls.length < 3) {
      createImmediateBall();
    }
  }
  
  // Update each ball position - OPTIMIZED calculation
  for (let i = 0; i < balls.length; i++) {
    let ball = balls[i];
    
    // Update position with minimal randomness for natural movement
    if (gameState === "playing") { // Only move balls when playing
      ball.y += ball.speed;
      // Apply horizontal drift only occasionally for performance
      if (frameCount % 3 === 0) {
        ball.x += random(-0.3, 0.3); // Reduced drift
      }
    }
  }
}

// Draw balls - SEPARATED from update for better performance
function drawBalls() {
  // Draw each ball
  for (let i = 0; i < balls.length; i++) {
    let ball = balls[i];
    
    // Only show balls if in playing state or if they've been explicitly touched
    if (gameState === "playing" || ball.touched) {
      if (ball.touched) {
        // Simplified glow for touched balls
        noStroke();
        fill(255, 192, 203, 60);
        circle(ball.x, ball.y, ball.size * 1.3);
        
        // Then draw the ball
        fill(255, 192, 203); // Pink for touched balls
      } else {
        // Simplified appearance for untouched balls
        noStroke();
        fill(0, 0, 139, 220); // Dark blue for untouched balls
      }
      
      circle(ball.x, ball.y, ball.size);
    }
  }
}

// Create floating score text
function createScoreText(x, y) {
  scoreTexts.push({
    x: x,
    y: y,
    age: 0,
    maxAge: 40 // Reduced frames for better performance (originally 60)
  });
}

// Create explosion particles when ball is hit
function createParticle(x, y) {
  // Only create particles if we don't already have too many
  if (particles.length < MAX_PARTICLES) {
    particles.push({
      x: x,
      y: y,
      vx: random(-2, 2), // Reduced velocity range
      vy: random(-4, 0), // Reduced velocity range
      size: random(5, 10), // Smaller particles
      color: color(255, 255, 255, 200),
      life: 255 // Will fade out
    });
  }
}

// Draw particles and score texts - OPTIMIZED
function drawEffects() {
  // Draw particles with simplified physics
  for (let i = particles.length - 1; i >= 0; i--) {
    let p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.1; // gravity
    p.life -= 12; // fade out faster
    
    if (p.life <= 0) {
      particles.splice(i, 1);
    } else {
      noStroke();
      fill(255, 255, 255, p.life);
      circle(p.x, p.y, p.size);
    }
  }
  
  // Draw score texts
  textAlign(CENTER, CENTER);
  for (let i = scoreTexts.length - 1; i >= 0; i--) {
    let t = scoreTexts[i];
    t.y -= 2; // Float upward
    t.age += 1.5; // Age faster
    
    if (t.age >= t.maxAge) {
      scoreTexts.splice(i, 1);
    } else {
      // Fade out towards the end
      let alpha = map(t.age, 0, t.maxAge, 255, 0);
      fill(255, 255, 0, alpha);
      textSize(20);
      text("+1", t.x, t.y);
    }
  }
}

// Check if level is complete - SIMPLIFIED
function checkLevelComplete() {
  const allTouched = balls.every(ball => ball.touched);
  const noBallsLeft = balls.length === 0;
  
  if ((allTouched || noBallsLeft) && gameState === "playing") {
    currentLevel++;
    levelBallCount = Math.min(levelBallCount + 2, 15);
    levelSpeed = Math.min(levelSpeed + 0.5, 5);
    levelBallSize = Math.max(levelBallSize - 2, 20);
    
    // Clear balls and create new ones for next level
    balls = [];
    createInitialBalls();
    
    // Notify TouchDesigner of level change
    if (webSocketConnected) {
      sendWebSocketData({
        type: "levelChange",
        level: currentLevel
      });
    }
  }
}

// Game completion check - SIMPLIFIED
function checkGameOver() {
  // If all balls have fallen off screen without being touched, game over
  if (balls.length === 0 && gameState === "playing") {
    gameState = "gameOver";
    window.trackingData.gameState = gameState;
    
    // Add a delay before returning to waiting state
    setTimeout(() => {
      resetGame();
    }, 3000);
    
    // Notify TouchDesigner of game over
    if (webSocketConnected) {
      sendWebSocketData({
        type: "gameOver",
        score: score
      });
    }
  }
}

// ---------------- DRAWING FUNCTIONS ----------------

// Simplified glow effect - much less expensive
function drawGlow(x, y, size, glowColor) {
  noStroke();
  
  // Just draw 2 circles for a simplified glow effect
  fill(red(glowColor), green(glowColor), blue(glowColor), 30);
  circle(x, y, size * 1.3);
  
  fill(red(glowColor), green(glowColor), blue(glowColor), 60);
  circle(x, y, size * 1.1);
}

// Draw camera permission status - SIMPLIFIED
function drawCameraStatus() {
  // Only show if we're not fully set up yet
  if (cameraPermissionState !== "granted" && !useTouchDesignerSensors) {
    fill(0, 0, 0, 180);
    rect(width/2 - 200, 10, 400, 30);
    
    textAlign(CENTER, CENTER);
    textSize(14);
    
    if (cameraPermissionState === "waiting") {
      fill(255, 255, 0);
      text("Waiting for camera permission...", width/2, 25);
    } else if (cameraPermissionState === "denied") {
      fill(255, 100, 100);
      text("Camera access denied. Touch detection unavailable.", width/2, 25);
    } else if (cameraPermissionState === "error") {
      fill(255, 100, 100);
      text("Camera error. Check permissions or use TouchDesigner.", width/2, 25);
    }
  }
}

// Draw TouchDesigner connection status - SIMPLIFIED
function drawConnectionStatus() {
  // Show active input mode text
  fill(255);
  noStroke();
  textSize(14);
  textAlign(RIGHT, TOP);
  
  const inputMode = useTouchDesignerSensors ? 
    "INPUT: TouchDesigner Sensors" : 
    "INPUT: Browser Pose Detection";
  
  text(inputMode, width - 20, 60);
  
  if (isTouchDesignerConnected) {
    fill(0, 255, 0); // Green
    text("TouchDesigner Connected", width - 20, 80);
  } else {
    fill(255, 200, 0); // Yellow
    text("Waiting for TouchDesigner...", width - 20, 80);
  }
}

// Draw TouchDesigner keypoints - SIMPLIFIED
function drawTouchDesignerKeypoints() {
  // Draw wrist points only for performance
  if (window.trackingData.wrists.left.active) {
    let x = window.trackingData.wrists.left.x;
    let y = window.trackingData.wrists.left.y;
    
    // Set color based on threshold if in waiting state
    let wristColor = (gameState === "waiting" && y < height * 0.6) ? 
      color(0, 255, 0, 200) : color(255, 255, 0, 200);
    
    // Draw wrist
    fill(wristColor);
    noStroke();
    circle(x, y, 15);
  }
  
  if (window.trackingData.wrists.right.active) {
    let x = window.trackingData.wrists.right.x;
    let y = window.trackingData.wrists.right.y;
    
    // Set color based on threshold if in waiting state
    let wristColor = (gameState === "waiting" && y < height * 0.6) ? 
      color(0, 255, 0, 200) : color(0, 255, 255, 200);
    
    // Draw wrist
    fill(wristColor);
    noStroke();
    circle(x, y, 15);
  }
}

// Draw keypoints - SIMPLIFIED
function drawKeypoints(pose) {
  // Reset wrist activity flags
  window.trackingData.wrists.left.active = false;
  window.trackingData.wrists.right.active = false;
  
  // Only draw wrist keypoints for performance
  for (let j = 0; j < pose.keypoints.length; j++) {
    let keypoint = pose.keypoints[j];
    
    // Only process wrist points
    if ((j === 9 || j === 10) && keypoint.confidence > 0.2) {
      // Update global wrist tracking data
      if (j === 9) {  // leftWrist
        window.trackingData.wrists.left.active = true;
        window.trackingData.wrists.left.x = keypoint.x;
        window.trackingData.wrists.left.y = keypoint.y;
      } else if (j === 10) {  // rightWrist
        window.trackingData.wrists.right.active = true;
        window.trackingData.wrists.right.x = keypoint.x;
        window.trackingData.wrists.right.y = keypoint.y;
      }
      
      // Color based on if wrist is above threshold when in waiting state
      let wristColor;
      if (gameState === "waiting" && keypoint.y < height * 0.6) {
        wristColor = color(0, 255, 0); // Green when above threshold
      } else {
        wristColor = color(255, 255, 0); // Yellow otherwise
      }
      
      fill(wristColor);
      noStroke();
      circle(keypoint.x, keypoint.y, 15);
    }
  }
}

// Enhanced debug visualization - SIMPLIFIED
function drawDebugInfo() {
  fill(255);
  noStroke();
  textSize(14);
  textAlign(LEFT, BOTTOM);
  text(`FPS: ${floor(frameRate())}`, 20, height - 20);
  
  // Draw game state
  fill(255, 255, 0);
  text(`Game State: ${gameState.toUpperCase()}`, 20, height - 40);
  
  // Only draw wrist indicators if active
  if (window.trackingData.wrists.left.active) {
    let x = window.trackingData.wrists.left.x;
    let y = window.trackingData.wrists.left.y;
    
    // Draw text
    fill(255, 255, 0);
    textSize(16);
    text(`LEFT`, x + 20, y);
    
    // Draw circle
    noFill();
    strokeWeight(2);
    stroke(255, 255, 0);
    circle(x, y, 80);
  }
  
  if (window.trackingData.wrists.right.active) {
    let x = window.trackingData.wrists.right.x;
    let y = window.trackingData.wrists.right.y;
    
    // Draw text
    fill(0, 255, 255);
    textSize(16);
    text(`RIGHT`, x + 20, y);
    
    // Draw circle
    noFill();
    strokeWeight(2);
    stroke(0, 255, 255);
    circle(x, y, 80);
  }
}

// Draw reset button - SIMPLIFIED
function drawResetButton() {
  // Draw a semi-transparent background for the button
  noStroke();
  fill(0, 0, 0, 150);
  const buttonWidth = 100;
  const buttonHeight = 40;
  const buttonX = width - buttonWidth - 10;
  const buttonY = height - buttonHeight - 10;
  
  // Draw button background
  rect(buttonX, buttonY, buttonWidth, buttonHeight, 10);
  
  // Draw button text
  fill(255);
  textSize(18);
  textAlign(CENTER, CENTER);
  text("Reset", buttonX + buttonWidth/2, buttonY + buttonHeight/2);
  
  // Check for mouse hover and click
  if (mouseX > buttonX && mouseX < buttonX + buttonWidth &&
      mouseY > buttonY && mouseY < buttonY + buttonHeight) {
    // Highlight on hover
    noFill();
    stroke(255, 255, 0);
    strokeWeight(2);
    rect(buttonX, buttonY, buttonWidth, buttonHeight, 10);
    
    // Check for click
    if (mouseIsPressed) {
      resetGame();
    }
  }
}

// Draw waiting screen with gesture instructions - SIMPLIFIED
function drawWaitingScreen() {
  // Draw transparent overlay
  fill(0, 0, 0, 180);
  rect(0, 0, width, height);
  
  // Draw title and instructions
  fill(255);
  textAlign(CENTER, CENTER);
  textSize(32);
  text("Motion Tracking Game", width/2, height/3 - 50);
  
  textSize(24);
  text("Raise your hand to start", width/2, height/2 - 40);
  
  // Draw a figure with hands raised (simplified)
  stroke(255);
  strokeWeight(2);
  noFill();
  
  const figureX = width/2;
  const figureY = height/2 + 50;
  const figureSize = min(width, height) * 0.2;
  
  // Body (simplified)
  line(figureX, figureY - figureSize*0.3, figureX, figureY + figureSize*0.3);
  circle(figureX, figureY - figureSize*0.4, figureSize*0.2);
  
  // Arms raised (simplified)
  line(figureX, figureY - figureSize*0.2, figureX - figureSize*0.3, figureY - figureSize*0.5);
  line(figureX, figureY - figureSize*0.2, figureX + figureSize*0.3, figureY - figureSize*0.5);
  
  // Hands (simplified)
  circle(figureX - figureSize*0.3, figureY - figureSize*0.5, figureSize*0.1);
  circle(figureX + figureSize*0.3, figureY - figureSize*0.5, figureSize*0.1);
  
  // Highlight hand position zone
  stroke(255, 255, 0, 150);
  strokeWeight(3);
  line(0, height * 0.6, width, height * 0.6);
  
  // Label for threshold line
  noStroke();
  fill(255, 255, 0);
  textSize(18);
  textAlign(LEFT, CENTER);
  text("Raise hand above this line", 20, height * 0.6 - 15);
  
  // Draw progress bar if gesture is being held
  if (gestureProgressBar > 0) {
    noStroke();
    fill(100);
    rect(width/2 - 150, height*0.7, 300, 30, 10);
    
    fill(0, 255, 0);
    rect(width/2 - 150, height*0.7, 300 * gestureProgressBar, 30, 10);
    
    fill(255);
    textSize(18);
    textAlign(CENTER, CENTER);
    text("Starting: " + Math.floor(gestureProgressBar * 100) + "%", width/2, height*0.7 + 15);
  }
  
  // Draw invisible balls that will be visible when game starts
  drawBalls();
  
  // Process movement for gesture detection
  if (useTouchDesignerSensors) {
    // Just draw the keypoints for feedback
    drawTouchDesignerKeypoints();
  } else if (isModelReady && ml5Available && poses.length > 0) {
    // Draw the keypoints (simplified)
    for (let i = 0; i < poses.length; i++) {
      drawKeypoints(poses[i]);
    }
  }
  
  // Draw hand position indicators (simplified)
  if (window.trackingData.wrists.left.active || window.trackingData.wrists.right.active) {
    noStroke();
    textAlign(CENTER, CENTER);
    textSize(18);
    
    if (window.trackingData.wrists.left.active) {
      const x = window.trackingData.wrists.left.x;
      const y = window.trackingData.wrists.left.y;
      
      if (y < height * 0.6) {
        fill(0, 255, 0, 200);
        text("✓", x, y - 30);
      } else {
        fill(255, 200, 0, 200);
        text("↑", x, y - 30);
      }
      
      fill(255, 255, 0, 180);
      ellipse(x, y, 40, 40);
    }
    
    if (window.trackingData.wrists.right.active) {
      const x = window.trackingData.wrists.right.x;
      const y = window.trackingData.wrists.right.y;
      
      if (y < height * 0.6) {
        fill(0, 255, 0, 200);
        text("✓", x, y - 30);
      } else {
        fill(255, 200, 0, 200);
        text("↑", x, y - 30);
      }
      
      fill(0, 255, 255, 180);
      ellipse(x, y, 40, 40);
    }
  }
}

// Game Over screen - SIMPLIFIED
function drawGameOverScreen() {
  // Draw transparent overlay
  fill(0, 0, 0, 200);
  rect(0, 0, width, height);
  
  // Draw game over message
  fill(255);
  textAlign(CENTER, CENTER);
  textSize(48);
  text("GAME OVER", width/2, height/3);
  
  // Show final score
  textSize(32);
  text("Final Score: " + score, width/2, height/2);
  
  // Show level reached
  textSize(24);
  text("Level Reached: " + currentLevel, width/2, height/2 + 50);
  
  // Instruction to restart
  textSize(20);
  fill(255, 255, 0);
  text("Game will restart in a few seconds...", width/2, height*0.7);
  
  // Draw reset button
  drawResetButton();
}

// Draw game screen with balls and interaction - OPTIMIZED
function drawGameScreen() {
  // Draw balls
  drawBalls();
  
  // Draw effects (particles and score texts)
  drawEffects();
  
  // Draw keypoints based on input mode
  if (useTouchDesignerSensors) {
    // Draw keypoints from TouchDesigner data (simplified)
    drawTouchDesignerKeypoints();
  } else if (isModelReady && ml5Available && poses.length > 0) {
    // Draw keypoints from browser pose detection (simplified)
    for (let i = 0; i < poses.length; i++) {
      drawKeypoints(poses[i]);
    }
    
    // Only draw debug info if debugging is enabled
    if (debugMode) {
      drawDebugInfo();
    }
  } else if (!isModelReady && !useTouchDesignerSensors) {
    // Show loading indicator (simplified)
    fill(255);
    textSize(24);
    textAlign(CENTER, CENTER);
    text("Loading pose detection...", width/2, height/2);
  }
  
  // Draw score
  noStroke();
  fill(0, 0, 0, 150);
  rect(10, 10, 150, 50, 10);
  
  fill(255);
  textSize(32);
  textAlign(LEFT, TOP);
  text("Score: " + score, 20, 20);
  
  // Draw level indicator
  fill(0, 0, 0, 150);
  rect(10, 70, 150, 30, 10);
  fill(255);
  textSize(18);
  text("Level: " + currentLevel, 20, 75);
  
  // Draw reset button
  drawResetButton();
}

// Main draw function - OPTIMIZED
function draw() {
  // Apply frame rate throttling for consistent performance
  const currentTime = millis();
  if (RENDER_THROTTLE > 0 && currentTime - lastRenderTime < RENDER_THROTTLE) {
    return;
  }
  lastRenderTime = currentTime;
  
  // Clear the background
  background(0, 10); // Semi-transparent background for motion trails
  
  // Display the video with reduced opacity for better game visibility
  if (video && cameraPermissionState === "granted") {
    tint(255, 200);
    image(video, 0, 0, width, height);
    noTint();
  }
  
  // Split update and render phases for better performance
  
  // 1. Update game logic
  updateGameLogic();
  
  // 2. Render the game
  renderGame();
  
  // 3. Push data to TouchDesigner (throttled inside function)
  pushDataToTouchDesigner();
}

// Update game logic - SEPARATED FOR PERFORMANCE
function updateGameLogic() {
  // Update ball physics
  updateBalls();
  
  // Process based on mode (TD sensors or browser pose detection)
  if (useTouchDesignerSensors) {
    // Check for ball collisions using TD wrist data
    if (window.trackingData.wrists.left.active) {
      checkBallCollision(
        window.trackingData.wrists.left.x,
        window.trackingData.wrists.left.y
      );
    }
    
    if (window.trackingData.wrists.right.active) {
      checkBallCollision(
        window.trackingData.wrists.right.x,
        window.trackingData.wrists.right.y
      );
    }
  } 
  // Browser pose detection mode
  else if (isModelReady && ml5Available && poses.length > 0) {
    // Check for ball collisions each frame using tracked wrists
    if (window.trackingData.wrists.left.active) {
      checkBallCollision(
        window.trackingData.wrists.left.x,
        window.trackingData.wrists.left.y
      );
    }
    
    if (window.trackingData.wrists.right.active) {
      checkBallCollision(
        window.trackingData.wrists.right.x,
        window.trackingData.wrists.right.y
      );
    }
  }
  
  // Check if level is complete
  checkLevelComplete();
  
  // Check for game over conditions
  checkGameOver();
  
  // Update score in tracking data
  window.trackingData.score = score;
  window.trackingData.gameState = gameState;
  window.trackingData.level = currentLevel;
}

// Render the game - SEPARATED FOR PERFORMANCE
function renderGame() {
  // Draw based on game state
  if (gameState === "waiting") {
    drawWaitingScreen();
  } else if (gameState === "playing") {
    drawGameScreen();
  } else if (gameState === "gameOver") {
    drawGameOverScreen();
  }
  
  // Draw connection indicator
  if (debugMode) {
    drawConnectionStatus();
  }
  
  // Draw camera permission status
  drawCameraStatus();
}

// ---------------- INPUT HANDLERS ----------------

// Handle window events
window.addEventListener('message', function(event) {
  // Check if the message is from TouchDesigner
  if (event.data && event.data.type === "TD_COMMAND") {
    
    // Handle different command types
    switch (event.data.command) {
      case "startGame":
        startGame();
        break;
      
      case "resetGame":
        resetGame();
        break;
      
      case "setWrist":
        if (event.data.data) {
          window.setWristFromTouchDesigner(
            event.data.data.wrist,
            event.data.data.x,
            event.data.data.y,
            event.data.data.active
          );
        }
        break;
    }
  }
});

// Handle window resizing
function windowResized() {
  containerWidth = windowWidth;
  containerHeight = windowHeight;
  
  // Resize canvas
  resizeCanvas(containerWidth, containerHeight);
  
  // Resize video
  if (video) {
    video.size(containerWidth, containerHeight);
  }
}

// Add mouse fallback for testing and reset button functionality
function mousePressed() {
  // Check if reset button was clicked
  const buttonWidth = 100;
  const buttonHeight = 40;
  const buttonX = width - buttonWidth - 10;
  const buttonY = height - buttonHeight - 10;
  
  if (mouseX > buttonX && mouseX < buttonX + buttonWidth &&
      mouseY > buttonY && mouseY < buttonY + buttonHeight) {
    resetGame();
    return;
  }
  
  // If we're in the instructions screen, start the game
  if (gameState === "waiting") {
    startGame();
    return;
  }
  
  // Check for collision at mouse position
  checkBallCollision(mouseX, mouseY);
}

// Add touch support for testing
function touchStarted() {
  // Check if reset button was touched
  const buttonWidth = 100;
  const buttonHeight = 40;
  const buttonX = width - buttonWidth - 10;
  const buttonY = height - buttonHeight - 10;
  
  let resetButtonTouched = false;
  
  for (let i = 0; i < touches.length; i++) {
    if (touches[i].x > buttonX && touches[i].x < buttonX + buttonWidth &&
        touches[i].y > buttonY && touches[i].y < buttonY + buttonHeight) {
      resetButtonTouched = true;
      break;
    }
  }
  
  if (resetButtonTouched) {
    resetGame();
    return false;
  }
  
  // If we're in the instructions screen, start the game
  if (gameState === "waiting") {
    startGame();
    return false;
  }
  
  // Check for collision at all touch points
  for (let i = 0; i < touches.length; i++) {
    checkBallCollision(touches[i].x, touches[i].y);
  }
  return false; // Prevent default
}

// Add keyboard controls for testing
function keyPressed() {
  // 'R' key to reset game
  if (key === 'r' || key === 'R') {
    resetGame();
  }
  
  // Spacebar to start game when in waiting state
  if (key === ' ' && gameState === "waiting") {
    startGame();
  }
}

// Export important functions to window for TouchDesigner
window.gameControls = {
  startGame: startGame,
  resetGame: resetGame,
  setDebugMode: function(enabled) {
    debugMode = enabled;
    return "Debug mode: " + (enabled ? "enabled" : "disabled");
  }
};