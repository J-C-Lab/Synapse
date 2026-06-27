import process from "node:process"
import { contextBridge, ipcRenderer } from "electron"

export interface CredentialSecretPromptContext {
  title: string
  message: string
}

function promptIdFromArgv(): string {
  const prefix = "--synapse-credential-prompt-id="
  const arg = process.argv.find((entry) => entry.startsWith(prefix))
  if (!arg) throw new Error("credential secret prompt id missing")
  return arg.slice(prefix.length)
}

const promptId = promptIdFromArgv()
const getContextChannel = `credential-secret:get-context:${promptId}`
const submitChannel = `credential-secret-submit:${promptId}`

contextBridge.exposeInMainWorld("credentialSecretPrompt", {
  getContext: (): Promise<CredentialSecretPromptContext> => ipcRenderer.invoke(getContextChannel),
  submit: (value: string | null): void => {
    ipcRenderer.send(submitChannel, value)
  },
})
