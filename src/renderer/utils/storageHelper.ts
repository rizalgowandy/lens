// Helper for working with storages (e.g. window.localStorage, NodeJS/file-system, etc.)

import type { CreateObservableOptions } from "mobx/lib/api/observable";
import { action, comparer, observable, toJS, when, IObservableValue } from "mobx";
import produce, { Draft, enableMapSet, setAutoFreeze } from "immer";
import { isEqual, isFunction, isPlainObject } from "lodash";
import logger from "../../main/logger";

setAutoFreeze(false); // allow to merge observables
enableMapSet(); // allow merging maps and sets

export interface StorageAdapter<T> {
  [metadata: string]: any;
  getItem(key: string): T | Promise<T>;
  setItem(key: string, value: T): void;
  removeItem(key: string): void;
  onChange?(change: { key: string, value: T, oldValue?: T }): void;
}

export interface StorageHelperOptions<T> {
  autoInit?: boolean; // start preloading data immediately, default: true
  observable?: CreateObservableOptions;
  storage: StorageAdapter<T>;
  defaultValue: T;
}

export class StorageHelper<T> {
  static readonly defaultOptions: Partial<StorageHelperOptions<any>> = {
    autoInit: true,
    observable: {
      deep: true,
      equals: comparer.shallow,
    }
  };

  private data: IObservableValue<T>;
  @observable initialized = false;
  whenReady = when(() => this.initialized);

  public readonly storage: StorageAdapter<T>;
  public readonly defaultValue: T;

  constructor(readonly key: string, private options: StorageHelperOptions<T>) {
    this.data = observable.box<T>(this.options.defaultValue, {
      ...StorageHelper.defaultOptions.observable,
      ...(options.observable ?? {})
    });
    this.data.observe(change => {
      const { newValue, oldValue } = toJS(change, { recurseEverything: true });

      this.onChange(newValue, oldValue);
    });

    this.storage = options.storage;
    this.defaultValue = options.defaultValue;

    if (this.options.autoInit) {
      this.init();
    }
  }

  private onData = (data: T): void => {
    const notEmpty = data != null;
    const notDefault = !this.isDefaultValue(data);

    if (notEmpty && notDefault) {
      this.merge(data);
    }

    this.initialized = true;
  };

  private onError = (error: any): void => {
    logger.error(`[load]: ${error}`, this);
  };

  @action
  init({ force = false } = {}) {
    if (this.initialized && !force) {
      return;
    }

    try {
      const data = this.storage.getItem(this.key);

      if (data instanceof Promise) {
        data.then(this.onData, this.onError);
      } else {
        this.onData(data);
      }
    } catch (error) {
      this.onError(error);
    }
  }

  isDefaultValue(value: T): boolean {
    return isEqual(value, this.defaultValue);
  }

  protected onChange(value: T, oldValue?: T) {
    if (!this.initialized) return;

    try {
      if (value == null) {
        this.storage.removeItem(this.key);
      } else {
        this.storage.setItem(this.key, value);
      }

      this.storage.onChange?.({ value, oldValue, key: this.key });
    } catch (error) {
      logger.error(`[change]: ${error}`, this, { value, oldValue });
    }
  }

  get(): T {
    return this.data.get();
  }

  set(value: T) {
    if (value == null) {
      // This cannot use recursion because defaultValue might be null or undefined
      this.data.set(this.defaultValue);
    } else {
      this.data.set(value);
    }
  }

  reset() {
    this.set(this.defaultValue);
  }

  merge(value: Partial<T> | ((draft: Draft<T>) => Partial<T> | void)) {
    const nextValue = produce(this.get(), (state: Draft<T>) => {
      const newValue = isFunction(value) ? value(state) : value;

      return isPlainObject(newValue)
        ? Object.assign(state, newValue) // partial updates for returned plain objects
        : newValue;
    });

    this.set(nextValue as T);
  }

  toJS() {
    return toJS(this.get(), { recurseEverything: true });
  }
}
