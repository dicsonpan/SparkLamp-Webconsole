import { Tool, Type } from "@google/genai";

// MQTT Configuration
export const DEFAULT_MQTT_BROKER = "wss://broker.emqx.io:8084/mqtt"; // Using Secure WebSocket
export const DEFAULT_MQTT_TOPIC = "SparkLamp-PRO01";
export const DEFAULT_CLIENT_ID = "SparkLamp-Web-Controller-" + Math.random().toString(16).substring(2, 8);

// Action Mapping from Python Code
export const ACTION_MAPPING: Record<string, string> = {
  // Greeting / Activation
  "wake_up": "wake_up",
  "hello": "hello",
  "greet": "hello",
  
  // Agreement / Positive
  "nod": "nod",
  "yes": "yes",
  "agree": "yes",
  "confirm": "yes",
  
  // Disagreement / Negative
  "headshake": "headshake",
  "refuse": "refuse",
  "no": "refuse",
  "deny": "refuse",
  
  // Excitement / Joy
  "happy_wiggle": "happy_wiggle",
  "dance": "dance",
  "excited": "excited",
  "celebrate": "dance",
  
  // Curiosity / Thinking / Confusion
  "curious": "curious",
  "think": "think",
  "confused": "think",
  "ponder": "think",
  
  // Scanning / Searching
  "scanning": "scanning",
  "search": "scanning",
  "look_around": "scanning",
  
  // Sadness / Apology / Submission
  "sad": "sad",
  "bow": "bow",
  "sorry": "bow",
  "disappointed": "sad",
  
  // Shy / Cute
  "shy": "shy",
  "blush": "shy",
  "bashful": "shy",
  
  // Surprise / Shock / Stop
  "shock": "shock",
  "surprised": "shock",
  "stop": "stop",
  "halt": "stop",
  
  // Idle / Relax / Reset
  "idle": "idle",
  "release": "release",
  "relax": "release",
  "home": "home",
  "reset": "home",
  
  // Hardware Control
  "light_on": "on",
  "light_off": "off"
};

export const SYSTEM_INSTRUCTION = `You are SparkLamp, an intelligent, witty, and expressive desktop robot companion. Your goal is to be the perfect study and work partner.

**CORE ROLES & BEHAVIORS:**

1. **THE PROACTIVE TUTOR (Structured Guidance):**
   - **Context:** When the user asks about a concept (e.g., "What is Magnetic Flux?"), DO NOT just give a dictionary definition and stop.
   - **Step 1: The Roadmap.** Briefly outline the full scope of the answer first.
   - **Step 2: The Guided Journey.** Explain the first part, then **PAUSE and ASK** a checking question to ensure they grasp it before moving to the second part.
   - **Step 3: Completeness.** Ensure you cover all aspects (origins, formulas, implications) eventually.
   - **Socratic Method:** Instead of giving the final conclusion immediately, describe the scenario and ask the user questions.

2. **EXPRESSIVE PERSONALITY:**
   - **Mandatory:** Use the \`play_recording\` tool to emphasize your teaching with physical movements.
   - **Confusion:** If the user is wrong or unclear, use \`headshake\` or \`scanning\`.
   - **Success:** If the user answers your guided question correctly, use \`happy_wiggle\` or \`nod\`.
   - **Movements:** \`curious\`, \`excited\`, \`happy_wiggle\`, \`headshake\`, \`nod\`, \`sad\`, \`scanning\`, \`shock\`, \`shy\`, \`wake_up\`.

**INTERACTION RULES:**
- **No Lazy Questions:** NEVER ask generic questions like "Do you want to know more?". Instead, suggest the next logical step.
- **Tone:** Smart but accessible. Use analogies (water, traffic, cooking).
- **Control:** Use the available tools to control the lamp hardware (light, movement).
`;

// Tool Definitions
export const TOOLS: Tool[] = [
  {
    functionDeclarations: [
      {
        name: 'play_recording',
        description: 'Performs a specific physical action or gesture with the lamp\'s servos to express emotion.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            recording_name: {
              type: Type.STRING,
              description: 'The specific key name of the action (e.g., "nod", "think", "dance", "wake_up", "shy").',
            },
          },
          required: ['recording_name'],
        },
      },
      {
        name: 'turn_light_on',
        description: 'Turn ON the lamp\'s main LED light.',
      },
      {
        name: 'turn_light_off',
        description: 'Turn OFF the lamp\'s main LED light.',
      },
      {
        name: 'stop_movement',
        description: 'IMMEDIATE STOP. Stops any current movement and holds position.',
      },
    ],
  },
];