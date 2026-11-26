{{/* Fixed base "neurouter", not .Chart.Name: the chart was renamed to neurouter-hub and resource
names and selector labels must not change on upgrade. */}}
{{- define "neurouter.name" -}}{{ .Values.nameOverride | default "neurouter" | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "neurouter.fullname" -}}
{{- if .Values.fullnameOverride -}}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else -}}{{- $n := include "neurouter.name" . -}}{{- if contains $n .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name $n | trunc 63 | trimSuffix "-" }}{{- end -}}{{- end -}}
{{- end -}}
{{- define "neurouter.labels" -}}
app.kubernetes.io/name: {{ include "neurouter.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
{{- define "neurouter.selectorLabels" -}}
app.kubernetes.io/name: {{ include "neurouter.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "neurouter.image" -}}{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}{{- end -}}
{{- define "neurouter.serviceAccountName" -}}{{ if .Values.serviceAccount.create }}{{ .Values.serviceAccount.name | default (include "neurouter.fullname" .) }}{{ else }}{{ .Values.serviceAccount.name | default "default" }}{{ end }}{{- end -}}
{{- define "neurouter.dbSecret" -}}{{ .Values.database.existingSecret | default (printf "%s-db" (include "neurouter.fullname" .)) }}{{- end -}}
{{- define "neurouter.cryptoSecret" -}}{{ .Values.crypto.existingSecret | default (printf "%s-crypto" (include "neurouter.fullname" .)) }}{{- end -}}
{{- define "neurouter.oidcSecret" -}}{{ .Values.oidc.existingSecret | default (printf "%s-oidc" (include "neurouter.fullname" .)) }}{{- end -}}

{{/* env + envFrom shared by the Deployment and the migration Job */}}
{{- define "neurouter.env" -}}
- name: DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ include "neurouter.dbSecret" . }}, key: DATABASE_URL } }
{{- if or .Values.database.auditUrl .Values.database.existingSecret }}
- name: AUDIT_DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ include "neurouter.dbSecret" . }}, key: AUDIT_DATABASE_URL, optional: true } }
{{- end }}
- name: NEUROUTER_MASTER_KEYS
  valueFrom: { secretKeyRef: { name: {{ include "neurouter.cryptoSecret" . }}, key: NEUROUTER_MASTER_KEYS } }
- name: NEUROUTER_ACTIVE_KEY_ID
  valueFrom: { secretKeyRef: { name: {{ include "neurouter.cryptoSecret" . }}, key: NEUROUTER_ACTIVE_KEY_ID } }
- name: HASH_PEPPER
  valueFrom: { secretKeyRef: { name: {{ include "neurouter.cryptoSecret" . }}, key: HASH_PEPPER } }
{{- if .Values.oidc.issuer }}
- name: OIDC_CLIENT_SECRET
  valueFrom: { secretKeyRef: { name: {{ include "neurouter.oidcSecret" . }}, key: OIDC_CLIENT_SECRET } }
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}
