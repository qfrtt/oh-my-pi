import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, type Context, type Model, streamSimple } from "@oh-my-pi/pi-ai";
import { renderPromptTemplate } from "../../config/prompt-templates";
import btwHandoffPrompt from "../../prompts/system/btw-handoff.md" with { type: "text" };
import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import { toReasoningEffort } from "../../thinking";
import { BtwPanelComponent } from "../components/btw-panel";
import type { InteractiveModeContext } from "../types";

interface BtwRequest {
	component: BtwPanelComponent;
	abortController: AbortController;
	question: string;
}

export interface BtwHistoryEntry {
	question: string;
	answer: string;
}

export class BtwController {
	#activeRequest: BtwRequest | undefined;
	#history: BtwHistoryEntry[] = [];
	readonly #streamFn: typeof streamSimple;

	constructor(
		private readonly ctx: InteractiveModeContext,
		options?: { streamFn?: typeof streamSimple },
	) {
		this.#streamFn = options?.streamFn ?? streamSimple;
	}

	get historyCount(): number {
		return this.#history.length;
	}

	hasActiveRequest(): boolean {
		return this.#activeRequest !== undefined;
	}

	handleEscape(): boolean {
		if (!this.#activeRequest) return false;
		this.#closeActiveRequest({ abort: this.#activeRequest.abortController.signal.aborted === false });
		return true;
	}

	dispose(): void {
		this.#closeActiveRequest({ abort: true });
		this.#history = [];
	}

	async start(question: string): Promise<void> {
		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) {
			this.ctx.showStatus("Usage: /btw <question>");
			return;
		}

		const roleModel = this.ctx.session.resolveRoleModel("btw");
		const model = roleModel ?? this.ctx.session.model;
		if (!model) {
			this.ctx.showError("No active model available for /btw.");
			return;
		}

		this.#closeActiveRequest({ abort: true });

		const modelLabel = roleModel ? this.#formatModelLabel(roleModel) : undefined;

		const request: BtwRequest = {
			component: new BtwPanelComponent({
				question: trimmedQuestion,
				tui: this.ctx.ui,
				historyCount: this.#history.length,
				modelLabel,
			}),
			abortController: new AbortController(),
			question: trimmedQuestion,
		};
		this.ctx.btwContainer.clear();
		this.ctx.btwContainer.addChild(request.component);
		this.ctx.ui.requestRender();
		this.#activeRequest = request;
		void this.#runRequest(request, model);
	}

	async handoff(): Promise<void> {
		if (this.#history.length === 0) {
			this.ctx.showStatus("No brainstorm history to hand off.");
			return;
		}

		const content = renderPromptTemplate(btwHandoffPrompt, { exchanges: this.#history });
		await this.ctx.session.sendCustomMessage(
			{
				customType: "btw-handoff",
				content,
				display: false,
			},
			{ deliverAs: "nextTurn", triggerTurn: false },
		);

		const count = this.#history.length;
		this.#history = [];
		this.ctx.showStatus(`Handed off ${count} brainstorm exchange${count === 1 ? "" : "s"} to session.`);
	}

	async #runRequest(
		request: BtwRequest,
		model: NonNullable<InteractiveModeContext["session"]["model"]>,
	): Promise<void> {
		try {
			const apiKey = await this.ctx.session.modelRegistry.getApiKey(model, this.ctx.session.sessionId);
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const messages: AgentMessage[] = [
				...this.#buildMessageSnapshot(),
				...this.#buildHistoryMessages(),
				this.#buildQuestionMessage(request.question),
			];
			const llmMessages = await this.ctx.session.convertMessagesToLlm(messages, request.abortController.signal);
			const context: Context = {
				systemPrompt: this.ctx.session.systemPrompt,
				messages: llmMessages,
			};
			const options = this.ctx.session.prepareSimpleStreamOptions({
				apiKey,
				sessionId: this.ctx.session.sessionId,
				reasoning: toReasoningEffort(this.ctx.session.thinkingLevel),
				serviceTier: this.ctx.session.serviceTier,
				signal: request.abortController.signal,
				toolChoice: "none",
			});
			const stream = this.#streamFn(model, context, options);

			for await (const event of stream) {
				if (!this.#isActiveRequest(request)) {
					return;
				}
				if (event.type === "text_delta") {
					request.component.appendText(event.delta);
					continue;
				}
				if (event.type === "done") {
					const finalText = this.#assistantText(event.message);
					if (finalText) {
						request.component.setAnswer(finalText);
						this.#history.push({ question: request.question, answer: finalText });
					}
					request.component.markComplete(this.#history.length);
					return;
				}
				if (event.type === "error") {
					if (event.reason === "aborted" || request.abortController.signal.aborted) {
						request.component.markAborted();
					} else {
						request.component.markError(
							this.#assistantText(event.error) || event.error.errorMessage || "BTW request failed.",
						);
					}
					return;
				}
			}
		} catch (error) {
			if (!this.#isActiveRequest(request)) {
				return;
			}
			if (request.abortController.signal.aborted) {
				request.component.markAborted();
				return;
			}
			request.component.markError(error instanceof Error ? error.message : String(error));
		}
	}

	#buildQuestionMessage(question: string): AgentMessage {
		return {
			role: "user",
			content: [
				{
					type: "text",
					text: renderPromptTemplate(btwUserPrompt, { question }),
				},
			],
			attribution: "user",
			timestamp: Date.now(),
		};
	}

	#buildHistoryMessages(): AgentMessage[] {
		const messages: AgentMessage[] = [];
		const now = Date.now();
		for (const entry of this.#history) {
			messages.push({
				role: "user",
				content: [
					{
						type: "text",
						text: renderPromptTemplate(btwUserPrompt, { question: entry.question }),
					},
				],
				attribution: "user",
				timestamp: now,
			});
			messages.push(this.#syntheticAssistantMessage(entry.answer, now));
		}
		return messages;
	}

	#buildMessageSnapshot(): AgentMessage[] {
		const messages = this.ctx.session.messages.slice();
		if (!this.ctx.session.isStreaming || !this.ctx.streamingMessage) {
			return messages;
		}
		const streamingText = this.ctx.extractAssistantText(this.ctx.streamingMessage);
		const lastMessage = messages.at(-1);
		if (!streamingText) {
			return lastMessage?.role === "assistant" ? messages.slice(0, -1) : messages;
		}
		const normalizedStreamingMessage: AssistantMessage = {
			...this.ctx.streamingMessage,
			content: [{ type: "text", text: streamingText }],
		};
		if (lastMessage?.role === "assistant") {
			return [...messages.slice(0, -1), normalizedStreamingMessage];
		}
		return [...messages, normalizedStreamingMessage];
	}

	#assistantText(message: AssistantMessage): string {
		let text = "";
		for (const content of message.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}
		return text.trim();
	}

	/** Minimal AssistantMessage for history replay — metadata is zeroed since it's never persisted. */
	#syntheticAssistantMessage(text: string, timestamp: number): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "synthetic",
			model: "btw-history",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp,
		};
	}

	#formatModelLabel(model: Model): string {
		return model.name ?? model.id;
	}

	#closeActiveRequest(options: { abort: boolean }): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		if (options.abort) {
			request.abortController.abort();
		}
		request.component.close();
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	#isActiveRequest(request: BtwRequest): boolean {
		return this.#activeRequest === request;
	}
}
