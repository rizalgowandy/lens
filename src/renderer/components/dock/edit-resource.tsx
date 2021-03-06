import "./edit-resource.scss";

import React from "react";
import { action, computed, observable } from "mobx";
import { observer } from "mobx-react";
import jsYaml from "js-yaml";
import { IDockTab } from "./dock.store";
import { cssNames } from "../../utils";
import { editResourceStore } from "./edit-resource.store";
import { InfoPanel } from "./info-panel";
import { Badge } from "../badge";
import { EditorPanel } from "./editor-panel";
import { Spinner } from "../spinner";
import { KubeObject } from "../../api/kube-object";

interface Props {
  className?: string;
  tab: IDockTab;
}

@observer
export class EditResource extends React.Component<Props> {
  @observable error = "";

  get tabId() {
    return this.props.tab.id;
  }

  get isReady() {
    return editResourceStore.isReady(this.tabId);
  }

  get resource(): KubeObject | undefined {
    return editResourceStore.getResource(this.tabId);
  }

  @computed get draft(): string {
    if (!this.isReady) {
      return ""; // wait until tab's data and kube-object resource are loaded
    }

    const { draft } = editResourceStore.getData(this.tabId);

    if (typeof draft === "string") {
      return draft;
    }

    return jsYaml.dump(this.resource); // dump resource first time
  }

  @action
  saveDraft(draft: string | KubeObject) {
    if (typeof draft === "object") {
      draft = draft ? jsYaml.dump(draft) : undefined;
    }

    editResourceStore.setData(this.tabId, {
      ...editResourceStore.getData(this.tabId),
      draft,
    });
  }

  onChange = (draft: string, error?: string) => {
    this.error = error;
    this.saveDraft(draft);
  };

  save = async () => {
    if (this.error) {
      return;
    }
    const store = editResourceStore.getStore(this.tabId);
    const updatedResource = await store.update(this.resource, jsYaml.safeLoad(this.draft));

    this.saveDraft(updatedResource); // update with new resourceVersion to avoid further errors on save
    const resourceType = updatedResource.kind;
    const resourceName = updatedResource.getName();

    return (
      <p>
        {resourceType} <b>{resourceName}</b> updated.
      </p>
    );
  };

  render() {
    const { tabId, error, onChange, save, draft, isReady, resource } = this;

    if (!isReady) {
      return <Spinner center/>;
    }

    return (
      <div className={cssNames("EditResource flex column", this.props.className)}>
        <InfoPanel
          tabId={tabId}
          error={error}
          submit={save}
          submitLabel="Save"
          submittingMessage="Applying.."
          controls={(
            <div className="resource-info flex gaps align-center">
              <span>Kind:</span> <Badge label={resource.kind}/>
              <span>Name:</span><Badge label={resource.getName()}/>
              <span>Namespace:</span> <Badge label={resource.getNs() || "global"}/>
            </div>
          )}
        />
        <EditorPanel
          tabId={tabId}
          value={draft}
          onChange={onChange}
        />
      </div>
    );
  }
}
