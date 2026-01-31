# **Eve – Progressive Web Application (PWA)**
*Your Gateway to AI on High-Performance PC Hardware*

---

**Unlock the Power of AI – Locally – with Eve: Your Personal AI Hub**

**(Image: A visually appealing screenshot of the Eve PWA interface – showing a clean, modern design with a conversation window and perhaps a visual representation of an LLM.)**

Are you ready to experience the power of Large Language Models (LLMs) without the hassle of complicated installations and cloud-based subscriptions?  Introducing **Eve**, a friendly Progressive Web App (PWA) that brings the best of AI directly to your local machine.  Whether you’re a gamer, a creative professional, a developer, or simply a tech enthusiast, Eve lets you effortlessly explore and experiment with AI on your MacBook Pro, gaming PC, or even a Raspberry Pi.

**What is Eve?**

Eve is a PWA that runs entirely on your local device, utilizing the incredible capabilities of locally installed LLMs provided by Ollama. This means you get instant access to AI, solid performance, and complete privacy – all without relying on internet connectivity.  It’s time to use your high-performance hardware for what it’s truly meant to do: drive AI innovation!

**Why Eve?**

Traditional AI tools can be daunting. Eve changes that. It’s designed for ease of use, offering:

*   **Instant AI Access:** Launch Eve directly from your browser with minimal setup.
*   **Hardware Optimization:** Eve adapts to your machine's power, ensuring smooth performance on Macs, Windows PCs, and even Raspberry Pi 5s.
*   **Beginner-Friendly:**  Start small, learn quickly, and scale your AI exploration as you grow.
*   **Versatile Applications:** From coding assistance and creative writing to data analysis and more, Eve effortlesly introduces AI.

**Who is Eve For?**

*   **Gamers & Creators:** Level up your games and creative projects with AI-powered tools.
*   **Developers & Engineers:**  Boost your productivity with AI assistance for coding, debugging, and data analysis.
*   **Students & Professionals:** Accelerate research, generate summaries, and automate tasks.
*   **Tech Enthusiasts:**  Experiment with AI on the edge – even on a Raspberry Pi 5!


**Getting Started with Eve – It's Easier Than You Think!**

Here's how to quickly get Eve up and running:

1.  **Install Ollama:** Ollama is the foundation of Eve. It’s a lightweight platform that allows you to run LLMs locally.
    *   **macOS:** Download the `.dmg` from [https://ollama.com/download](https://ollama.com/download) and drag **Ollama** to your Applications folder.
    *   **Windows:** Download the `.exe` installer from the same link and follow the prompts.
    *   **Linux:**  Use the install script: `curl -fsSL https://ollama.com/install.sh | sh` (Check the Ollama documentation for specific instructions for your Linux distribution)
    *   **Raspberry Pi:**  Install via `.deb` package or the install script mentioned above. *Important:* Ensure you're running a 64-bit OS for optimal performance.

2.  **Pull an AI Model:** Once Ollama is installed, you need to choose a model to use with Eve.
    *   Type `ollama list` in your terminal. This shows you the available models.
    *   To pull a model (e.g., ‘gemma3’), type `ollama pull gemma3`.

3.  **Launch Eve:** Next, pool Eve's repo from github, start the local http server using python command line and open Eve in your browser. For more details, navigate to the URL provided in the Eve documentation.

**Your First Interaction:  A Writing Assistant Example**

Let's walk through a simple example:  creating a JSON file using Eve’s help.

1.  **Pre-Context Setup:** In Eve, click the “Add” button to add some initial context to help Eve understand the task.  Type in the following:

    ```plaintext
    You are a helpful assistant specializing in Node.js development.  Your goal is to assist the user in creating and manipulating JSON files.
    ```
2.  **Task Prompt:** Now, enter your request in the text box.  Be specific!  For example:

    ```plaintext
    Create a new JSON file named "data.json" with a single key called "current" and its value set to an empty object.  Save the file to the current directory.
    ```

3. **Send the Request:** Click the “Send” button.  Eve will use the model to generate the appropriate Node.js code to complete your task.

**Saving and Sharing Your Work**

Eve allows you to easily save and share your conversations:

* **Download All:** Click the Download All button to save all messages to a file.
* **Load All:**  Click the Load All Button to upload saved conversations back into Eve.

**Ready to Dive In?**

[Link to Eve's Get Started Documentation]:  (https://github.com/pub-head2toes-org/pub-head2toes-org.github.io/tree/main/eve)

**Start your AI journey today with Eve – the PWA that puts the power of AI directly into your hands!**


---

## References
- [eve PWA link](https://git.head2toes.org/eve)
- [eve readme.md](https://github.com/pub-head2toes-org/pub-head2toes-org.github.io/tree/main/eve)
