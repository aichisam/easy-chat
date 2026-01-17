"use client";

import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Sun, Moon, Paperclip, X } from "lucide-react";
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

// --- TYPE DEFINITIONS (Unchanged) ---
type ApiPart = { text: string; } | { inline_data: { mime_type: string; data: string; }; };
type ApiContent = { role: "user" | "model"; parts: ApiPart[]; };
type Message = { id: number; text: string; sender: "user" | "bot"; };

declare global {
  interface Window {
    pdfjsLib: any;
  }
}

export default function ChatBot() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [theme, setTheme] = useState("light");
  const [files, setFiles] = useState<File[]>([]);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Hooks for loading libraries, scrolling, and theme (Unchanged) ---
  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js";
    script.async = true;
    script.onload = () => { if (window.pdfjsLib) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js"; }};
    document.body.appendChild(script);
    return () => { document.body.removeChild(script); };
  }, []);

  useEffect(() => {
    if (chatContainerRef.current) { chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight; }
  }, [messages, isTyping]);

  useEffect(() => {
    const savedTheme = localStorage.getItem("theme") || "light";
    setTheme(savedTheme);
    if (savedTheme === "dark") { document.documentElement.classList.add("dark"); }
  }, []);

  const toggleTheme = () => {
    document.documentElement.classList.toggle("dark");
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(prevFiles => [...prevFiles, ...Array.from(e.target.files!)]);
    }
  };
  
  const handleRemoveFile = (fileToRemove: File) => {
    setFiles(prevFiles => prevFiles.filter(file => file !== fileToRemove));
  };

  // --- parseFile function (Unchanged but vital) ---
  const parseFile = async (f: File): Promise<ApiPart[]> => {
    const name = f.name.toLowerCase();
    const type = f.type;
    if (type.startsWith("image/")) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          const base64Data = (event.target?.result as string).split(',')[1];
          resolve([{ inline_data: { mime_type: type, data: base64Data } }]);
        };
        reader.onerror = (err) => reject(new DOMException("Failed to read image.", err as any));
        reader.readAsDataURL(f);
      });
    }
    return new Promise<ApiPart[]>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new DOMException("Problem parsing the input file."));
      reader.onload = async (event) => {
        try {
          const buffer = event.target?.result;
          let textContent = `[Content from file: ${f.name}]\n\n`;
          if (name.endsWith(".docx")) {
            const result = await mammoth.extractRawText({ arrayBuffer: buffer as ArrayBuffer });
            textContent += result.value;
          } else if (name.endsWith(".pdf")) {
            const pdf = await window.pdfjsLib.getDocument({ data: buffer as ArrayBuffer }).promise;
            for (let i = 1; i <= pdf.numPages; i++) {
              const page = await pdf.getPage(i);
              const content = await page.getTextContent();
              textContent += content.items.map((item: any) => item.str).join(" ") + "\n";
            }
          } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
            const workbook = XLSX.read(buffer, { type: 'array' });
            workbook.SheetNames.forEach(sheetName => {
              const worksheet = workbook.Sheets[sheetName];
              const csv = XLSX.utils.sheet_to_csv(worksheet);
              textContent += `--- Sheet: ${sheetName} ---\n${csv}\n`;
            });
          } else if (type.startsWith("text/")) {
            textContent += buffer;
          } else {
            textContent += `(This file type '${type}' is not supported for text extraction.)`;
          }
          resolve([{ text: textContent }]);
        } catch (err) {
          reject(new DOMException("Failed to parse file content.", err as any));
        }
      };
      if (type.startsWith("text/") || name.endsWith(".json") || name.endsWith(".md") || name.endsWith(".csv")) {
        reader.readAsText(f);
      } else {
        reader.readAsArrayBuffer(f);
      }
    });
  };

  // <-- THIS FUNCTION IS HEAVILY MODIFIED FOR DEBUGGING AND ROBUSTNESS -->
  const handleSend = async () => {
    if (!input.trim() && files.length === 0) return;

    setIsTyping(true);

    // Get the API key from environment variables
    const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;

    if (!apiKey) {
      console.error("API key is missing. Ensure NEXT_PUBLIC_GEMINI_API_KEY is set in .env.local and you've restarted the server.");
      setMessages(prev => [...prev, { id: Date.now(), text: "Error: API Key not configured.", sender: "bot" }]);
      setIsTyping(false);
      return;
    }

    const userMessageText = input.trim() + (files.length > 0 ? ` (Attached: ${files.length} files)` : "");
    const userMessageForUI: Message = { id: Date.now(), text: userMessageText, sender: "user" };
    setMessages((prev) => [...prev, userMessageForUI]);
    
    const apiHistory: ApiContent[] = messages.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'model',
      parts: [{ text: msg.text }],
    }));

    try {
      const newUserParts: ApiPart[] = [];
      if (input.trim()) {
        newUserParts.push({ text: input.trim() });
      }
      
      if (files.length > 0) {
        // Use Promise.all to wait for all files to be parsed.
        const fileParts = await Promise.all(files.map(file => parseFile(file)));
        // .flat() converts the array of arrays into a single array of parts
        newUserParts.push(...fileParts.flat());
      }
      
      const apiBodyContents: ApiContent[] = [...apiHistory, { role: "user", parts: newUserParts }];

      // --- VITAL DEBUGGING STEP ---
      // Log the exact payload being sent to the API. You can check this in your browser's console.
      console.log("Sending to API:", JSON.stringify(apiBodyContents, null, 2));
      
      setInput("");
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      
      const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: apiBodyContents }),
      });

      if (!resp.ok) {
        // Try to get a more detailed error message from the API's response body
        const errorData = await resp.json().catch(() => null);
        const errorMessage = errorData?.error?.message || `API request failed with status ${resp.status}`;
        throw new Error(errorMessage);
      }
      
      const jsonResponse = await resp.json();
      // Add a check in case the response format is unexpected
      const replyText = jsonResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!replyText) {
        console.error("Unexpected API response format:", jsonResponse);
        throw new Error("No text found in API response.");
      }
      
      setMessages((prev) => [...prev, { id: Date.now() + 1, text: replyText, sender: "bot" }]);

    } catch (err) {
      // This will now print the specific, detailed error to the console.
      console.error("An error occurred during handleSend:", err);
      // Display a more informative error message in the chat UI.
      const errorMessage = (err instanceof Error) ? err.message : "An unknown error occurred.";
      setMessages((prev) => [...prev, { id: Date.now() + 1, text: `Sorry, an error occurred: ${errorMessage}`, sender: "bot" }]);
    } finally {
      setIsTyping(false);
    }
  };

  // --- JSX for Rendering (Unchanged, but ensure it matches this structure) ---
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl flex flex-col h-[700px] w-full max-w-lg mx-auto">
      <div className="p-4 border-b dark:border-gray-700 flex justify-between items-center">
        <h1 className="font-bold text-xl dark:text-white">🤖 Chat with Easychat</h1>
        <Button onClick={toggleTheme} size="icon" variant="ghost">
          {theme === "light" ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
        </Button>
      </div>

      <div ref={chatContainerRef} className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.sender === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`whitespace-pre-wrap rounded-xl px-4 py-2 max-w-[85%] text-sm ${ msg.sender === "user" ? "bg-blue-600 text-white dark:bg-blue-700" : "bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200" }`}>
              {msg.text}
            </div>
          </div>
        ))}
        {isTyping && (
          <div className="flex justify-start">
            <div className="rounded-xl px-4 py-3 max-w-[75%] text-sm bg-gray-200 dark:bg-gray-700 dark:text-white">
              <div className="flex items-center space-x-2">
                <p>Generating response...</p>
                <span className="h-1.5 w-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 bg-gray-500 rounded-full animate-bounce" />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="p-4 border-t bg-gray-50 dark:bg-gray-700 dark:border-gray-600">
        {files.length > 0 && (
          <div className="mb-2 space-y-2">
            {files.map((file, index) => (
              <div key={index} className="flex items-center justify-between bg-gray-100 dark:bg-gray-600 p-2 rounded-md text-sm">
                <span className="truncate pr-2 dark:text-gray-200">{file.name}</span>
                <Button onClick={() => handleRemoveFile(file)} size="icon" variant="ghost" className="h-6 w-6">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); handleSend(); }} className="flex items-center gap-3">
          <input
            id="file-upload"
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.csv,.json,.md,.xls,.xlsx,image/*"
            onChange={handleFileChange}
            ref={fileInputRef}
            className="hidden"
            disabled={isTyping}
          />
          <Button type="button" size="icon" variant="ghost" onClick={() => fileInputRef.current?.click()} disabled={isTyping}>
            <Paperclip className="h-5 w-5" />
          </Button>
          <Input
            placeholder="Type your message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isTyping}
            autoComplete="off"
            className="flex-1 bg-white dark:bg-gray-600 dark:text-white border-gray-300 dark:border-gray-500 rounded-full focus:ring-2 focus:ring-blue-500"
          />
          <Button type="submit" disabled={isTyping || (!input.trim() && files.length === 0)} className="rounded-full">
            Send
          </Button>
        </form>
      </div>
    </div>
  );
}