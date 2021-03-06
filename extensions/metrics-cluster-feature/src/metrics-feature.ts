import { ClusterFeature, Catalog, K8sApi } from "@k8slens/extensions";
import semver from "semver";
import * as path from "path";

export interface MetricsConfiguration {
  // Placeholder for Metrics config structure
  persistence: {
    enabled: boolean;
    storageClass: string;
    size: string;
  };
  nodeExporter: {
    enabled: boolean;
  };
  kubeStateMetrics: {
    enabled: boolean;
  };
  retention: {
    time: string;
    size: string;
  };
  alertManagers: string[];
  replicas: number;
  storageClass: string;
}

export class MetricsFeature extends ClusterFeature.Feature {
  name = "metrics";
  latestVersion = "v2.19.3-lens1";

  templateContext: MetricsConfiguration = {
    persistence: {
      enabled: false,
      storageClass: null,
      size: "20G",
    },
    nodeExporter: {
      enabled: true,
    },
    retention: {
      time: "2d",
      size: "5GB",
    },
    kubeStateMetrics: {
      enabled: true,
    },
    alertManagers: null,
    replicas: 1,
    storageClass: null,
  };

  async install(cluster: Catalog.KubernetesCluster): Promise<void> {
    // Check if there are storageclasses
    const storageClassApi = K8sApi.forCluster(cluster, K8sApi.StorageClass);
    const scs = await storageClassApi.list();

    this.templateContext.persistence.enabled = scs.some(sc => (
      sc.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true" ||
      sc.metadata?.annotations?.["storageclass.beta.kubernetes.io/is-default-class"] === "true"
    ));

    super.applyResources(cluster, path.join(__dirname, "../resources/"));
  }

  async upgrade(cluster: Catalog.KubernetesCluster): Promise<void> {
    return this.install(cluster);
  }

  async updateStatus(cluster: Catalog.KubernetesCluster): Promise<ClusterFeature.FeatureStatus> {
    try {
      const statefulSet = K8sApi.forCluster(cluster, K8sApi.StatefulSet);
      const prometheus = await statefulSet.get({name: "prometheus", namespace: "lens-metrics"});

      if (prometheus?.kind) {
        this.status.installed = true;
        this.status.currentVersion = prometheus.spec.template.spec.containers[0].image.split(":")[1];
        this.status.canUpgrade = semver.lt(this.status.currentVersion, this.latestVersion, true);
      } else {
        this.status.installed = false;
      }
    } catch(e) {
      if (e?.error?.code === 404) {
        this.status.installed = false;
      }
    }

    return this.status;
  }

  async uninstall(cluster: Catalog.KubernetesCluster): Promise<void> {
    const namespaceApi = K8sApi.forCluster(cluster, K8sApi.Namespace);
    const clusterRoleBindingApi = K8sApi.forCluster(cluster, K8sApi.ClusterRoleBinding);
    const clusterRoleApi = K8sApi.forCluster(cluster, K8sApi.ClusterRole);

    await namespaceApi.delete({name: "lens-metrics"});
    await clusterRoleBindingApi.delete({name: "lens-prometheus"});
    await clusterRoleApi.delete({name: "lens-prometheus"});
  }
}
