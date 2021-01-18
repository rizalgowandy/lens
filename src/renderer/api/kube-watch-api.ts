// Kubernetes watch-api client

import type { Cluster } from "../../main/cluster";
import type { IKubeWatchEvent, IKubeWatchEventStreamEnd, IWatchRoutePayload } from "../../main/routes/watch-route";

import type { KubeObject } from "./kube-object";
import { computed, observable, reaction } from "mobx";
import { autobind, EventEmitter } from "../utils";
import { ensureObjectSelfLink, KubeApi } from "./kube-api";
import { KubeJsonApiData, KubeJsonApiError } from "./kube-json-api";
import { KubeObjectStore } from "../kube-object.store";
import { apiPrefix, isProduction } from "../../common/vars";
import { apiManager } from "./api-manager";

export { IKubeWatchEvent, IKubeWatchEventStreamEnd };

export interface IKubeWatchMessage<T extends KubeObject = any> {
  data?: IKubeWatchEvent<KubeJsonApiData>
  error?: IKubeWatchEvent<KubeJsonApiError>;
  api?: KubeApi<T>;
  store?: KubeObjectStore<T>;
}

export interface IKubeWatchLog {
  message: string | Error;
  meta?: object | any;
}

@autobind()
export class KubeWatchApi {
  protected stream: ReadableStream<Uint8Array>; // https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Using_readable_streams
  protected subscribers = observable.map<KubeApi, number>();
  protected reconnectTimeoutMs = 5000;
  protected maxReconnectsOnError = 10;

  // events
  onMessage = new EventEmitter<[IKubeWatchMessage]>();

  constructor() {
    this.bindAutoConnect();
  }

  private bindAutoConnect() {
    return reaction(() => this.activeApis, () => this.connect(), {
      fireImmediately: true,
      delay: 500,
    });
  }

  @computed get activeApis() {
    return Array.from(this.subscribers.keys());
  }

  getSubscribersCount(api: KubeApi) {
    return this.subscribers.get(api) || 0;
  }

  subscribe(...apis: KubeApi[]) {
    apis.forEach(api => {
      this.subscribers.set(api, this.getSubscribersCount(api) + 1);
    });

    return () => apis.forEach(api => {
      const count = this.getSubscribersCount(api) - 1;

      if (count <= 0) this.subscribers.delete(api);
      else this.subscribers.set(api, count);
    });
  }

  protected async resolveCluster(): Promise<Cluster> {
    const { getHostedCluster } = await import("../../common/cluster-store");

    return getHostedCluster();
  }

  protected async getRequestPayload(): Promise<IWatchRoutePayload> {
    const cluster = await this.resolveCluster();
    const { namespaceStore } = await import("../components/+namespaces/namespace.store");

    await namespaceStore.whenReady;

    return {
      apis: this.activeApis.map(api => {
        if (!cluster.isAllowedResource(api.kind)) {
          return [];
        }

        if (api.isNamespaced) {
          return namespaceStore.getContextNamespaces().map(namespace => api.getWatchUrl(namespace));
        } else {
          return api.getWatchUrl();
        }
      }).flat()
    };
  }

  protected async connect() {
    this.disconnect(); // close active connection first

    const payload = await this.getRequestPayload();

    if (!payload.apis.length) {
      return;
    }

    this.log({
      message: "connecting",
      meta: payload,
    });

    try {
      const req = await fetch(`${apiPrefix}/watch`, {
        method: "POST",
        body: JSON.stringify(payload),
        keepalive: true,
        headers: {
          "content-type": "application/json"
        }
      });

      const reader = req.body.getReader();
      const handleEvent = this.handleStreamEvent.bind(this);

      this.stream = new ReadableStream({
        start(controller) {
          return reader.read().then(function processEvent({ done, value }): Promise<void> {
            if (done) {
              controller.close();

              return;
            }
            handleEvent(value);
            controller.enqueue(value);

            return reader.read().then(processEvent);
          });
        },
        cancel() {
          reader.cancel();
        }
      });
    } catch (error) {
      this.log({
        message: new Error("connection error"),
        meta: { error }
      });
    }
  }

  protected async disconnect() {
    if (this.stream) {
      this.stream.cancel();
      this.stream = null;
    }
  }

  protected handleStreamEvent(chunk: Uint8Array) {
    const jsonText = new TextDecoder().decode(chunk);

    if (!jsonText) {
      return;
    }

    // decoded json might contain multiple kube-events at a time
    const events = jsonText.trim().split("\n");

    events.forEach(event => {
      try {
        const message = this.getMessage(JSON.parse(event));

        this.onMessage.emit(message);
      } catch (error) {
        this.log({
          message: new Error("failed to parse watch-api event"),
          meta: { error, event },
        });
      }
    });
  }

  protected getMessage(event: IKubeWatchEvent): IKubeWatchMessage {
    const message: IKubeWatchMessage = {};

    switch (event.type) {
      case "ADDED":
      case "DELETED":

      case "MODIFIED": {
        const data = event as IKubeWatchEvent<KubeJsonApiData>;
        const api = apiManager.getApiByKind(data.object.kind, data.object.apiVersion);

        message.data = data;

        if (api) {
          ensureObjectSelfLink(api, data.object);

          const { namespace, resourceVersion } = data.object.metadata;

          api.setResourceVersion(namespace, resourceVersion);
          api.setResourceVersion("", resourceVersion);

          message.api = api;
          message.store = apiManager.getStore(api);
        }
        break;
      }

      case "ERROR":
        message.error = event as IKubeWatchEvent<KubeJsonApiError>;
        break;

      case "STREAM_END": {
        this.onServerStreamEnd(event as IKubeWatchEventStreamEnd);
        break;
      }
    }

    return message;
  }

  protected async onServerStreamEnd(event: IKubeWatchEventStreamEnd) {
    const { apiBase, namespace } = KubeApi.parseApi(event.url);
    const api = apiManager.getApi(apiBase);

    if (api) {
      try {
        await api.refreshResourceVersion({ namespace });
        this.connect();
      } catch (error) {
        this.log({
          message: new Error("failed to reconnect on stream end"),
          meta: { error, event },
        });

        if (this.subscribers.size > 0) {
          setTimeout(() => {
            this.onServerStreamEnd(event);
          }, 1000);
        }
      }
    }
  }

  protected log({ message, meta }: IKubeWatchLog) {
    if (isProduction) return;

    const logMessage = `%c[KUBE-WATCH-API]: ${String(message).toUpperCase()}`;
    const isError = message instanceof Error;
    const textStyle = `font-weight: bold; ${isError ? "color: red;" : ""}`;

    if (isError) {
      console.error(logMessage, textStyle, meta);
    } else {
      console.info(logMessage, textStyle, meta);
    }
  }
}

export const kubeWatchApi = new KubeWatchApi();
