Real-Time Code Editor

A full-stack real-time collaborative code editor that enables multiple users to code, communicate, and collaborate live. The platform integrates CRDT-based synchronization, WebRTC video and voice communication, chat, and code execution into one seamless experience.

Features
Real-Time Code Collaboration

Multiple users can edit code simultaneously. The system uses CRDT-based synchronization to ensure conflict-free editing.

Live Chat System

Includes a built-in chat system for team communication. Messaging is handled in real time using WebSockets.

Project and File Management

Users can create and manage projects with a structured file system for organizing code efficiently.

Code Execution

Allows users to run code directly from the editor through API integration. Supports multiple programming languages.

Authentication System

Provides secure login and signup functionality using JWT or Clerk-based authentication. Handles user sessions safely.

WebSocket Communication

Ensures real-time updates across users using Socket.IO or WebSocket technology, enabling low-latency collaboration.

AI Panel

Includes an optional AI assistant panel that helps with coding tasks and suggestions.

Video and Voice Collaboration

Supports peer-to-peer video and audio communication using WebRTC. Enables real-time interaction between team members while coding with low latency.

How Video and Voice Works

The system uses WebRTC peer-to-peer connections for communication. Signaling is handled through WebSockets.

This enables:
Audio calls
Video calls
Group collaboration sessions

Tech Stack
Frontend

HTML, CSS, JavaScript with a custom user interface for the editor, dashboard, and chat system.

Backend

Node.js with Express.js for server-side logic.

Database

MongoDB using Mongoose for data modeling.

Real-Time Communication

Socket.IO or WebSocket for real-time features.

Additional Tools

JWT for authentication
CRDT for real-time collaboration
Piston API for code execution

Project Structure

future-code-editor-main/

config/ contains database configuration
models/ contains Mongoose models
routes/ contains API routes
public/ contains frontend files such as HTML, CSS, and JavaScript
websocket/ contains WebSocket handlers
server.js is the main server entry point
database.js handles database connection

Usage

Open the application in a browser.
Login or create an account.
Create or join a project.
Invite teammates to collaborate.

Start coding together, chatting, and using video or voice communication in real time.

What Makes This Project Special

This project combines a code editor, chat system, and video calling into a single platform. It uses CRDT-based synchronization similar to collaborative tools like Google Docs and provides a complete real-time collaboration environment for developers.
