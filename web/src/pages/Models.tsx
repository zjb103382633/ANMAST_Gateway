import { useEffect, useState } from "react";
import {
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  InputNumber,
  Popconfirm,
  message,
  Typography,
  AutoComplete,
} from "antd";
import { PlusOutlined, ReloadOutlined, LoadingOutlined } from "@ant-design/icons";
import { api } from "../api";
import { useCurrency } from "../currency";

interface Provider {
  id: string;
  name: string;
}
interface Tier {
  id: string;
  name: string;
}
interface Model {
  id: string;
  provider_id: string;
  name: string;
  display_name: string;
  tiers: string;
  capabilities: string;
  context_window: number;
  input_price: number;
  input_cache_read_price?: number;
  input_cache_write_price?: number;
  output_price: number;
  priority: number;
  is_router: number;
  usage?: string;
  auto_compress?: number;
  max_context_tokens?: number | null;
  enabled: number;
  provider_name?: string;
}
interface DiscoveredModel {
  id: string;
  context_window: number | null;
  input_price?: number | null;
  cache_read_price?: number | null;
  cache_write_price?: number | null;
  output_price?: number | null;
}

const ROUTER_ONLY = "__router_only__";
const ASSISTANT_ONLY = "__assistant_only__";

function parseTiers(m: Model): string[] {
  try {
    const t = JSON.parse(m.tiers);
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
}

export default function Models() {
  const [data, setData] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Model | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [form] = Form.useForm();
  const { currency, toDisplay, fromDisplay, formatPrice } = useCurrency();

  const load = () => {
    setLoading(true);
    Promise.all([
      api.get<Model[]>("/api/models"),
      api.get<Provider[]>("/api/providers"),
      api.get<Tier[]>("/api/tiers"),
    ])
      .then(([m, p, t]) => {
        setData(m);
        setProviders(p);
        setTiers(t);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const fetchModels = async (providerId: string) => {
    setLoadingModels(true);
    setDiscovered([]);
    try {
      const r = await api.get<{ models: DiscoveredModel[] }>(`/api/providers/${providerId}/models`);
      setDiscovered(r.models ?? []);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoadingModels(false);
    }
  };

  const onProviderChange = (providerId: string) => {
    form.setFieldsValue({ name: undefined, context_window: 128000 });
    fetchModels(providerId);
  };

  const onModelSelect = async (modelId: string) => {
    const providerId = form.getFieldValue("provider_id");
    // 显示名同步为所选模型 ID
    form.setFieldsValue({ display_name: modelId });
    const found = discovered.find((d) => d.id === modelId);
    if (found) {
      // 自动填入上下文窗口与价格（价格按当前币种换算）
      const patch: Record<string, unknown> = {};
      if (found.context_window) patch.context_window = found.context_window;
      if (found.input_price != null) patch.input_price = toDisplay(found.input_price);
      if (found.cache_read_price != null) patch.input_cache_read_price = toDisplay(found.cache_read_price);
      if (found.cache_write_price != null) patch.input_cache_write_price = toDisplay(found.cache_write_price);
      if (found.output_price != null) patch.output_price = toDisplay(found.output_price);
      form.setFieldsValue(patch);
      if (found.context_window) return;
    }
    // 列表未携带上下文，尝试拉取详情
    setContextLoading(true);
    try {
      const r = await api.get<{ context_window: number | null }>(
        `/api/providers/${providerId}/models/${encodeURIComponent(modelId)}/context`,
      );
      if (r.context_window) form.setFieldsValue({ context_window: r.context_window });
    } catch {
      /* ignore */
    } finally {
      setContextLoading(false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setDiscovered([]);
    form.resetFields();
    form.setFieldsValue({
      tiers: ["medium"],
      context_window: 128000,
      input_price: 0,
      input_cache_read_price: 0,
      input_cache_write_price: 0,
      output_price: 0,
      priority: 100,
      is_router: false,
      auto_compress: false,
      max_context_tokens: undefined,
      tools: true,
      vision: false,
    });
    setOpen(true);
  };

  const openEdit = (m: Model) => {
    setEditing(m);
    let cap: { tools?: boolean; vision?: boolean } = {};
    try {
      cap = JSON.parse(m.capabilities);
    } catch {
      /* ignore */
    }
    let tiersField = parseTiers(m);
    if (m.usage === "router_only") tiersField = [ROUTER_ONLY];
    else if (m.usage === "assistant_only") tiersField = [ASSISTANT_ONLY];
    form.setFieldsValue({
      ...m,
      tiers: tiersField,
      is_router: !!m.is_router,
      auto_compress: !!m.auto_compress,
      max_context_tokens: m.max_context_tokens ?? undefined,
      tools: cap.tools !== false,
      vision: !!cap.vision,
      input_price: toDisplay(m.input_price),
      input_cache_read_price: toDisplay(m.input_cache_read_price ?? 0),
      input_cache_write_price: toDisplay(m.input_cache_write_price ?? 0),
      output_price: toDisplay(m.output_price),
    });
    fetchModels(m.provider_id);
    setOpen(true);
  };

  const onTiersChange = (vals: string[]) => {
    const special = vals.find((v) => v === ROUTER_ONLY || v === ASSISTANT_ONLY);
    if (special) {
      form.setFieldsValue({ tiers: [special] });
      if (special === ROUTER_ONLY) form.setFieldsValue({ is_router: true });
    } else {
      form.setFieldsValue({ tiers: vals });
    }
  };

  const submit = async () => {
    const values = await form.validateFields();
    const tierVals: string[] = values.tiers ?? [];
    let usage = "normal";
    let tiersArr = tierVals;
    if (tierVals.includes(ROUTER_ONLY)) {
      usage = "router_only";
      tiersArr = [];
    } else if (tierVals.includes(ASSISTANT_ONLY)) {
      usage = "assistant_only";
      tiersArr = [];
    }
    const body = {
      ...values,
      tiers: tiersArr,
      usage,
      is_router: usage === "router_only" ? true : !!values.is_router,
      input_price: fromDisplay(Number(values.input_price ?? 0)),
      input_cache_read_price: fromDisplay(Number(values.input_cache_read_price ?? 0)),
      input_cache_write_price: fromDisplay(Number(values.input_cache_write_price ?? 0)),
      output_price: fromDisplay(Number(values.output_price ?? 0)),
      auto_compress: !!values.auto_compress,
      max_context_tokens: values.max_context_tokens ?? null,
      capabilities: JSON.stringify({ tools: !!values.tools, vision: !!values.vision }),
    };
    delete body.tools;
    delete body.vision;
    try {
      if (editing) await api.put(`/api/models/${editing.id}`, body);
      else await api.post("/api/models", body);
      message.success("已保存");
      setOpen(false);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const toggleEnabled = async (m: Model) => {
    try {
      await api.put(`/api/models/${m.id}`, { enabled: m.enabled ? 0 : 1 });
      message.success(m.enabled ? `已停用 ${m.display_name || m.name}` : `已启用 ${m.display_name || m.name}`);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const tierName = (id: string) => tiers.find((t) => t.id === id)?.name ?? id;

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: "space-between", width: "100%" }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          模型管理
        </Typography.Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            添加模型
          </Button>
        </Space>
      </Space>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={data}
        columns={[
          { title: "显示名", dataIndex: "display_name" },
          { title: "模型 ID", dataIndex: "name", render: (v: string) => <Tag>{v}</Tag> },
          { title: "供应商", dataIndex: "provider_name" },
          {
            title: "用途 / 复杂度层级",
            dataIndex: "tiers",
            render: (_: string, r: Model) => {
              if (r.usage === "router_only") return <Tag color="cyan">仅复杂度判定</Tag>;
              if (r.usage === "assistant_only") return <Tag color="geekblue">仅AI助手</Tag>;
              return parseTiers(r).map((t) => (
                <Tag key={t} color="purple">
                  {tierName(t)}
                </Tag>
              ));
            },
          },
          {
            title: "路由模型",
            dataIndex: "is_router",
            render: (v: number) => (v ? <Tag color="cyan">复杂度判定</Tag> : "—"),
          },
          {
            title: "上下文",
            dataIndex: "context_window",
            render: (v: number) => v.toLocaleString(),
          },
          {
            title: "自动压缩",
            dataIndex: "auto_compress",
            render: (_: unknown, r: Model) =>
              r.auto_compress ? (
                <Tag color="green">
                  {((r.max_context_tokens ?? r.context_window) || 0).toLocaleString()} · 阈值可调
                </Tag>
              ) : (
                "—"
              ),
          },
          {
            title: `价格 (每1M, ${currency})`,
            render: (_: unknown, r: Model) => (
              <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
                <span>未命中 {formatPrice(r.input_price)}</span>
                <span>命中缓存 {formatPrice(r.input_cache_read_price ?? 0)}</span>
                <span>缓存写入 {formatPrice(r.input_cache_write_price ?? 0)}</span>
                <span>输出 {formatPrice(r.output_price)}</span>
              </Space>
            ),
          },
          {
            title: "状态",
            dataIndex: "enabled",
            render: (v: number, r: Model) => (
              <Switch
                checked={!!v}
                checkedChildren="启用"
                unCheckedChildren="停用"
                onChange={() => toggleEnabled(r)}
              />
            ),
          },
          {
            title: "操作",
            render: (_, r: Model) => (
              <Space>
                <Button size="small" onClick={() => openEdit(r)}>
                  编辑
                </Button>
                <Popconfirm
                  title="删除该模型？"
                  onConfirm={async () => {
                    await api.del(`/api/models/${r.id}`);
                    message.success("已删除");
                    load();
                  }}
                >
                  <Button size="small" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? "编辑模型" : "添加模型"}
        open={open}
        onOk={submit}
        onCancel={() => setOpen(false)}
        width={640}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="provider_id" label="供应商" rules={[{ required: true }]}>
            <Select
              options={providers.map((p) => ({ value: p.id, label: p.name }))}
              placeholder="选择供应商（自动拉取该 API Key 下的模型）"
              onChange={onProviderChange}
            />
          </Form.Item>
          <Form.Item
            name="name"
            label="模型 ID"
            rules={[{ required: true }]}
            extra="选择供应商后自动列出可用模型，也可手动输入"
          >
            <AutoComplete
              options={discovered.map((d) => ({
                value: d.id,
                label: d.context_window ? `${d.id}（上下文 ${d.context_window.toLocaleString()}）` : d.id,
              }))}
              onSelect={onModelSelect}
              placeholder="如 gpt-4o"
              filterOption={(input, option) =>
                (option?.value ?? "").toString().toLowerCase().includes(input.toLowerCase())
              }
            >
              <Input suffix={loadingModels ? <LoadingOutlined /> : null} />
            </AutoComplete>
          </Form.Item>
          <Form.Item name="display_name" label="显示名">
            <Input placeholder="GPT-4o" />
          </Form.Item>
          <Form.Item
            name="tiers"
            label="适用的复杂度层级"
            rules={[{ required: true }]}
            extra="选择「仅作为…」后，该模型不参与普通复杂度路由，仅用于对应用途"
          >
            <Select
              mode="multiple"
              onChange={onTiersChange}
              options={[
                ...tiers.map((t) => ({ value: t.id, label: `${t.name} (${t.id})` })),
                { value: ROUTER_ONLY, label: "仅作为复杂度判定模型" },
                { value: ASSISTANT_ONLY, label: "仅作为网页AI助手模型" },
              ]}
            />
          </Form.Item>
          <Space size={16} style={{ display: "flex" }}>
            <Form.Item name="context_window" label="上下文窗口" style={{ flex: 1 }} extra={contextLoading ? "获取中…" : undefined}>
              <InputNumber style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="priority" label="优先级（越小越优先）" style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: "flex" }}>
            <Form.Item
              name="max_context_tokens"
              label="压缩触发上下文上限（tokens）"
              style={{ flex: 1 }}
              extra="自动压缩的触发参考线，留空则使用上下文窗口；触发比例在「压缩」设置页配置"
            >
              <InputNumber style={{ width: "100%" }} min={0} step={1000} />
            </Form.Item>
          </Space>
          <Form.Item
            name="auto_compress"
            label="自动压缩上下文（ucomp）"
            valuePropName="checked"
            extra="勾选后网关监控该模型每个会话的上下文，达到阈值先压缩历史再重组请求转发；优先于全局压缩设置"
          >
            <Switch />
          </Form.Item>
          <Typography.Text strong>价格（每 1M tokens，{currency}）</Typography.Text>
          <Space size={16} style={{ display: "flex", marginTop: 8 }}>
            <Form.Item name="input_price" label="输入 · 未命中缓存" style={{ flex: 1 }}>
              <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="input_cache_read_price" label="输入 · 命中缓存" style={{ flex: 1 }}>
              <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: "flex" }}>
            <Form.Item name="input_cache_write_price" label="输入 · 缓存写入" style={{ flex: 1 }}>
              <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="output_price" label="输出" style={{ flex: 1 }}>
              <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
            </Form.Item>
          </Space>
          <Space size={24}>
            <Form.Item name="is_router" label="用作复杂度判定模型" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="tools" label="支持工具调用" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="vision" label="支持视觉" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
