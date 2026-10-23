import { useEffect, useState } from "react";
import { Card, Form, InputNumber, Switch, Select, Button, message, Typography, Space, Alert, Tag } from "antd";
import { api } from "../api";

interface CompressionConfig {
  enabled: boolean;
  anchor_messages: number;
  window_messages: number;
  summarize_middle: boolean;
  summary_model: string;
  auto_threshold_percent: number;
  ucomp_summary_model: string;
}

interface UcompStatus {
  available: boolean;
  python_version?: string;
  ucomp_version?: string | null;
  error?: string;
}

export default function Compression() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [modelOpts, setModelOpts] = useState<{ name: string; display_name: string }[]>([]);
  const [ucompStatus, setUcompStatus] = useState<UcompStatus | null>(null);

  useEffect(() => {
    api.get<CompressionConfig>("/api/compression").then((c) => {
      form.setFieldsValue(c);
      setEnabled(c.enabled);
    });
    api.get<{ name: string; display_name: string }[]>("/api/models").then((ms) => setModelOpts(ms));
    api.get<UcompStatus>("/api/compression/ucomp-status").then(setUcompStatus).catch(() => setUcompStatus({ available: false, error: "请求失败" }));
  }, [form]);

  const save = async () => {
    const v = await form.validateFields();
    setLoading(true);
    try {
      await api.put("/api/compression", { ...v, enabled });
      message.success("压缩设置已保存");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: "100%", maxWidth: 760 }}>
      <Card title="按模型自动压缩（ucomp）">
        <Alert
          type="info"
          showIcon
          message="监控每个会话的上下文，达到阈值先压缩、再重组请求"
          description={
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              在「模型管理」页为模型勾选「自动压缩上下文」并配置压缩触发上限后，网关按下方触发比例估算每次请求的上下文
              token，达到阈值时调用 universal-context-compaction 压缩历史（保留首条与近期原文，中间生成摘要，超大工具输出落盘外置），
              再用压缩后的消息重组请求转发上游。同一会话历史未变时复用上次摘要，不重复压缩。
            </Typography.Paragraph>
          }
        />
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Space size={16} style={{ display: "flex" }}>
            <Form.Item
              name="auto_threshold_percent"
              label="触发阈值（占上下文上限 %）"
              style={{ flex: 1 }}
              extra="估算 token 达到 上限 × 该比例 时触发压缩；留出输出余量，默认 80"
              rules={[{ required: true }]}
            >
              <InputNumber min={1} max={100} style={{ width: "100%" }} addonAfter="%" />
            </Form.Item>
            <Form.Item
              name="ucomp_summary_model"
              label="摘要模型"
              style={{ flex: 1 }}
              extra="压缩时用它生成历史摘要（OpenAI 兼容接口，直连供应商）；留空 = 内置规则摘要器，不调用模型"
            >
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="留空 = 内置规则摘要器"
                options={modelOpts.map((m) => ({ value: m.name, label: m.display_name || m.name }))}
              />
            </Form.Item>
          </Space>
          <Form.Item label="ucomp 运行环境">
            {ucompStatus === null ? (
              <Typography.Text type="secondary">检测中…</Typography.Text>
            ) : ucompStatus.available ? (
              <Space size={8}>
                <Tag color="green">可用</Tag>
                <Typography.Text type="secondary">
                  Python {ucompStatus.python_version} · ucomp {ucompStatus.ucomp_version}
                </Typography.Text>
              </Space>
            ) : (
              <Space size={8}>
                <Tag color="red">不可用</Tag>
                <Typography.Text type="secondary">
                  {ucompStatus.error ?? "缺少 python3 或 ucomp 包"}——自动压缩将不生效，消息原样转发
                </Typography.Text>
              </Space>
            )}
          </Form.Item>
          <Button type="primary" loading={loading} onClick={save}>
            保存
          </Button>
        </Form>
      </Card>

      <Card title="全局压缩（按 API Key 开关）">
        <Alert
          type="info"
          showIcon
          message="头部锚点 + 近期窗口 + 中间摘要/丢弃"
          description={
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              压缩在网关路由后对历史消息生效：保留开头的锚点消息（对应注意力锚点，稳定前缀可命中缓存）与最近的消息原文，
              中间部分按配置摘要或丢弃。仅影响发往上游的输入，不改动当前这条新消息。
              模型勾选「自动压缩上下文」后优先走按模型压缩，本节配置不再对该模型生效。
            </Typography.Paragraph>
          }
        />
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="启用压缩" extra="关闭后消息原样透传，不产生压缩率数据">
            <Switch checked={enabled} onChange={setEnabled} />
          </Form.Item>
          <Space size={16} style={{ display: "flex" }}>
            <Form.Item
              name="anchor_messages"
              label="头部锚点保留条数"
              style={{ flex: 1 }}
              extra="保留开头的若干条消息（含 system/首个任务上下文）"
              rules={[{ required: true }]}
            >
              <InputNumber min={0} max={50} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              name="window_messages"
              label="近期保留条数"
              style={{ flex: 1 }}
              extra="保留最近的若干条消息原文"
              rules={[{ required: true }]}
            >
              <InputNumber min={1} max={200} style={{ width: "100%" }} />
            </Form.Item>
          </Space>
          <Form.Item
            name="summarize_middle"
            label="中间部分用摘要补偿"
            valuePropName="checked"
            extra="开启后用低成本模型把中间历史摘要成一段；关闭则直接丢弃中间历史"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="summary_model" label="摘要模型" extra="留空则自动使用复杂度判定模型">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="留空 = 使用复杂度判定模型"
              options={modelOpts.map((m) => ({ value: m.name, label: m.display_name || m.name }))}
            />
          </Form.Item>
          <Button type="primary" loading={loading} onClick={save}>
            保存
          </Button>
        </Form>
      </Card>
    </Space>
  );
}
