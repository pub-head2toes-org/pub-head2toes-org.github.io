# **Eve – Progressive Web Application (PWA) Reference Manual**
*Your Gateway to AI on High-Performance PC Hardware*

---

## **1. Introduction**
Welcome to **Eve**, your all-in-one Progressive Web Application (PWA) designed to unlock the full potential of your cutting-edge hardware—whether it’s a **MacBook Pro/Air/Mini**, **NVIDIA RTX-powered gaming PC**, or even a **16GB Raspberry Pi 5**. With Eve, you can seamlessly integrate AI into your workflow without the complexity of traditional software setups.

This manual will guide you through installation, setup, and usage of Eve, ensuring you can start leveraging AI capabilities right away—from AI-powered productivity tools to creative applications and beyond.

---

## **2. Motivation for the Application**
### **Why Eve?**
You’ve just invested in top-tier hardware, but now you’re left wondering: *How can I make the most of it?* The answer lies in **AI**, but traditional AI tools often require steep learning curves, fragmented workflows, or even dedicated AI PCs. Eve eliminates these barriers by providing:

- **Instant AI Access**: No need for complex installations—Eve runs as a **PWA**, meaning you can launch it directly from your browser with minimal setup.
- **Hardware Optimization**: Whether you’re on a **Mac, Windows, or Raspberry Pi**, Eve adapts to your system’s capabilities, ensuring smooth AI performance.
- **Beginner-Friendly**: Designed for users who want to explore AI without deep technical knowledge. Start small, scale as you grow.
- **Versatility**: From **AI-assisted coding** to **creative design tools**, Eve integrates AI into your daily tasks effortlessly.

### **Who Is This For?**
- **Gamers & Creators**: Maximize your RTX/GPU power for AI-enhanced gaming, art, or video editing.
- **Developers & Engineers**: Use AI to debug code, generate prototypes, or analyze data faster.
- **Students & Professionals**: Leverage AI for research, summaries, or automation without a steep learning curve.
- **Tech Enthusiasts**: Experiment with AI on **Raspberry Pi 5** or other edge devices.

---

# **3. Installation & Setup**
Before launching **Eve**, you’ll need to install **Ollama** on your local machine and pull a desired AI model. This ensures Eve can communicate with your AI models seamlessly. Below is a step-by-step guide tailored for **Mac, Windows, Linux, and Raspberry Pi**.

---

## **3.1 Prerequisites**
### **1. Install Ollama**
Ollama is a lightweight AI deployment platform that hosts models locally. Follow these steps to install it:

#### **For macOS**
1. **Download Ollama**:
   - Visit the [Ollama Download Page](https://ollama.com/download) and download the `.dmg` file for macOS.
   - Open the `.dmg` file and drag **Ollama** to your **Applications** folder.

2. **Install via Homebrew (Alternative)**:
   ```bash
   brew install ollama/tap/ollama
   ```

#### **For Windows**
1. **Download Ollama**:
   - Visit the [Ollama Download Page](https://ollama.com/download) and download the `.exe` installer.
   - Run the installer and follow the prompts to complete the installation.

#### **For Linux (Debian/Ubuntu)**
1. **Add Ollama’s repository**:
   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ```
   (For other Linux distributions, check the [Ollama Docs](https://ollama.com/download).)

#### **For Raspberry Pi (ARM-based)**
1. **Install via `.deb` package** (recommended for Pi OS):
   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ```
   (Ensure your Pi is running **64-bit OS** for best performance.)

2. **Verify Installation**:
   ```bash
   ollama --version
   ```
   (You should see the installed version, e.g., `Ollama version v0.1.1`.)

---

### **2. Pull an AI Model**
Ollama hosts a variety of open-source models. To use Eve, you’ll need to download one. Here’s how:

#### **List Available Models**
```bash
ollama list
```
(Check the [Ollama Models Page](https://ollama.com/models) for the latest options.)

#### **Pull a Model (Example: `gemma3`)**
```bash
ollama pull gemma3
```
(Replace `gemma3` with your preferred model, e.g., `llama2`, `mistral`, or `phi`.)

#### **Verify the Model**
```bash
ollama list
```
(You should see your model listed under `REPOSITORIES`.)

---

## **3.2 Launching Eve**
Once Ollama is installed and a model is pulled, you can launch **Eve** via your browser.

### **Option 1: Install Eve as a PWA (Progressive Web App) from Local Server**
1. **Open Command Shell**:
  - To start Eve PWA in local server open the command shell to prepare and start the local server:
  ```bash
  git clone https://github.com/pub-head2toes-org/pub-head2toes-org.github.io.git
  ```
  ```bash
  cd pub-head2toes-org.github.io
  ```
  ```bash
  python3 -m http.server
  ```

2. **Open Eve in Your Browser**:
   - Visit the Eve PWA localhost URL: ```bash http://localhost:8000/eve/```
   - Optional: **Install** to add Eve to your home screen.

*(Note: Need to elaborate on need to run the local server)*

### **Option 2: Install Eve as a PWA (Progressive Web App)**
1. **Open Eve in Your Browser**:
   - Visit the Eve PWA URL (e.g., `https://git.head2toes.org/eve` or a local dev server if self-hosted).
   - Click **"Install"** (Chrome/Firefox/Edge) to add Eve to your home screen.

2. **First-Time Setup**:
   - Run the proxy server in your local machine
   - One example is the pure Node JS proxy server: [Example Proxy Server](https://stackoverflow.com/questions/20351637/how-to-create-a-simple-http-proxy-in-node-js)

*(Note: Need to elaborate on need to run the proxy server)*

---

## **3.3 Troubleshooting**
### **Issue: Ollama Not Running**
- **Check the service**:
  ```bash
  ollama serve
  ```
  (Run this in a separate terminal tab.)

- **Firewall/Network Issues**:
  Ensure your machine allows connections on `localhost:11434`.

### **Issue: Model Not Found**
- Verify the model name:
  ```bash
  ollama list
  ```
- Pull the correct model (e.g., `ollama pull llama2`).

### **Issue: Eve Can’t Connect to Ollama**
- Confirm Ollama is running:
  ```bash
  curl http://localhost:11434
  ```
  (Should return a JSON response.)

- Check Eve’s API endpoint settings (if self-hosted).

---

 # **4. First Run – Getting Started**

Now that you've successfully installed Ollama and Eve, let’s dive into your first experience using **Eve**.

---

## **4.1 Initial Setup**
### **1. API Endpoint**
By default, **Eve** communicates with Ollama on `localhost:11434`. If you changed the port or IP address during installation, update the **API Endpoint** field accordingly (e.g., `http://localhost:12345`).

### **2. Model Selection**
To start using AI, first refresh your Ollama models list by running `ollama list`. Then select a model from the dropdown (Ex.: `mistral:7b`).

### **3. Context Size**
Initially set the **Context Size** to 4096 tokens for better performance. You can adjust this value later if needed, but keep in mind that larger context sizes require more RAM.

---

## **4.2 Preparing Your LLM**
Before sending tasks, it’s essential to prepare your AI assistant with some context (also known as pre-context). This helps the model understand the task better and generate accurate responses.

### **1. Add Pre-Context**
In the message list, click on the **"Add"** button and enter your desired pre-context:
```plaintext
You are a code assistant capable of writing a Node.js code using the following considerations.
```
### **2. Define Your Task**
Now you can define your task in the message list below the pre-context. Here’s an example prompt for a JSON file manipulation task:
```bash
* read a JSON file from the file system
* JSON file has a key "current"
```
```json
{
  "current": {}
}
```
```plaintext
* create a new JSON file with only this key and its value copied, and save it back in the file system.
```

### **3. Send Your Task**
Click on the **"Send"** button to initiate the task. Eve will communicate with Ollama to generate the appropriate code for your specified task.

---

## **4.3 Interacting With Eve**
Once you send a task, Eve will display the AI’s response in the message list below. If you need further clarification or wish to refine your task, simply edit and resend it.

As you work with **Eve**, experiment with different models, context sizes, and prompts to explore the full potential of the AI integration within Eve.

---

 # **6. Integration with File System – Saving and Loading Data**
In this chapter, we'll explore how to integrate **Eve** with your local file system to save, restore, and share your data seamlessly.

---

## **6.1 Downloading Data**
### **1. Save Individual Messages**
When you want to keep or share a specific conversation with **Eve**, click the **"Download"** icon next to each message in the message list. This will save the selected message(s) as a plain text file on your local machine.

### **2. Download All Messages**
To download all messages within a session, use the **"Download All"** button from the main menu (top-right corner). This will generate a compressed archive containing all your saved messages in plain text format.

---

## **6.2 Uploading Data**
### **1. Load Individual Messages**
To load an individual message(s) into **Eve**, use the **"Load"** button (located below the pre-context field). Navigate to your saved messages, select the desired files, and click "Open." The selected message(s) will be loaded into the message list.

### **2. Upload All Data**
To upload all saved messages back into **Eve**, use the **"Load All"** button from the main menu (top-right corner). Navigate to your saved data archive, select the file, and click "Open." The entire conversation history will be loaded into the message list.

---

## **Best Practices**
To maintain consistency in your conversations with **Eve**, it's essential to frequently download your data and always download before uploading previous save data. This ensures that your local data is up-to-date and minimizes potential inconsistencies during upload.

---

## **Additional Features: Loading Individual Prompts**
In addition to loading entire conversations, the **"Load"** button allows you to load individual prompts from the file system. This can be useful when composing more complex prompts broken down into smaller messages.

---

  # **7. Sessions – Managing Your Conversations**
In this chapter, we'll explore how to manage your conversations with **Eve** using sessions. This feature allows you to organize and navigate through multiple interactions easily.

---

## **7.1 Understanding Sessions**
### **1. Grouping Messages**
Each conversation within **Eve** is divided into **sessions**, where a session represents a collection of related messages. The initial **current** session is created when you first start interacting with the assistant.

### **2. Starting Fresh and Duplicating Sessions**
There might be situations when you want to start a new conversation, remove some messages from an existing one, or experiment with different approaches. To do this, use either the **"New Session"** or **"Dup Session"** buttons (located in the main menu – top-right corner).

#### **a. New Session**
Creates a fresh session without any messages. You can start interacting with the assistant from scratch.

#### **b. Dup Session**
Duplicates the current session by creating a new one with all its messages, leaving the original unchanged. This allows you to experiment with variations or maintain multiple versions of your conversation.

---

## **7.2 Navigating Sessions**
### **1. Accessing Available Sessions**
All your sessions are listed in the left sidebar under the **"Sessions"** section. Clicking on a session will load all its data into the workspace, allowing you to interact with it or make further changes.

---


