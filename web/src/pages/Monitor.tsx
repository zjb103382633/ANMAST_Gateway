import { useEffect, useState } from "react";
import {
  Badge,
  Card,
  Empty,
  Row,
  Col,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { api } from "../api";
import dayjs from "dayjs";

interface InFlight {
  id: string;
  model: string;
  startedAt: number;
  streaming: boolean;
  elapsedMs: number;
}

interface SessionRow {
  conversationId: string;
  sourceSessionId: string | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  clientIp: string | null;
  protocol: string;
  title: string;
  modelRequested: string;
  model: string;
  streaming: boolean;
  activeRequests: number;
  requestCount: number;
  errorCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
  cacheHitRate: number | null;
  speed: number | null;
  firstAt: number;
  lastAt: number;
  lastError: string | null;
  inFlight: InFlight[];
}

interface Snapshot {
  activeRequests: number;
  sessionCount: number;
  activeSessionCount: number;
  sessions: SessionRow[];
}

const fmtTokens = (v: number) => v.toLocaleString("zh-CN");
const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

function CacheHitRate({ rate, read, write }: { rate: number | null; read: number; write: number }) {
  if (rate == null) return <Typography.Text type="secondary">—</Typography.Text>;
  const pct = rate * 100;
  const color = pct >= 60 ? "green" : pct > 0 ? "orange" : "default";
  return (
    <Tooltip
      title={
        <div>
          <div>命中缓存：{fmtTokens(read)} tokens</div>
          <div>缓存写入：{fmtTokens(write)} tokens</div>
        </div>
      }
    >
      <Tag color={color} style={{ cursor: "help", marginInlineEnd: 0 }}>
        {pct.toFixed(1)}%
      </Tag>
    </Tooltip>
  );
}

export default function Monitor() {
  const [snap, setSnap] = useState<Snapshot>({
    activeRequests: 0,
    sessionCount: 0,
    activeSessionCount: 0,
    sessions: [],
  });

  // 监控面板为实时视图，固定每秒轮询（内存态接口，开销极小）
  useEffect(() => {
    const load = () => api.get<Snapshot>("/api/monitor/sessions").then(setSnap).catch(() => {});
    load();
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, []);

  const totalSpeed = snap.sessions.reduce((acc, s) => acc + (s.speed ?? 0), 0);

  const columns: ColumnsType<SessionRow> = [
    {
      title: "状态",
      width: 110,
      render: (_: unknown, r: SessionRow) =>
        r.streaming ? (
          <Badge status="processing" text="流式输出中" />
        ) : r.activeRequests > 0 ? (
          <Badge status="warning" text="处理中" />
        ) : (
          <Badge status="default" text="空闲" />
        ),
    },
    {
      title: "会话",
      ellipsis: true,
      render: (_: unknown, r: SessionRow) => (
        <Space direction="vertical" size={0} style={{ minWidth: 0 }}>
          <Typography.Text strong ellipsis style={{ maxWidth: 260 }}>
            {r.title || "（无标题）"}
          </Typography.Text>
          <Typography.Text type="secondary" copyable={{ text: r.conversationId }} style={{ fontSize: 12 }}>
            {shortId(r.conversationId)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "来源 Session ID",
      width: 180,
      render: (_: unknown, r: SessionRow) =>
        r.sourceSessionId ? (
          <Tooltip title={r.sourceSessionId}>
            <Typography.Text copyable={{ text: r.sourceSessionId }} style={{ fontSize: 12 }}>
              {shortId(r.sourceSessionId)}
            </Typography.Text>
          </Tooltip>
        ) : (
          <Tooltip title="客户端未提供 session id，由网关按 API Key + 标题归并会话">
            <Typography.Text type="secondary">—</Typography.Text>
          </Tooltip>
        ),
    },
    {
      title: "来源 IP",
      dataIndex: "clientIp",
      width: 130,
      render: (v: string | null) => v ?? "—",
    },
    {
      title: "API Key",
      dataIndex: "apiKeyName",
      width: 120,
      ellipsis: true,
      render: (v: string | null) => v ?? "—",
    },
    {
      title: "协议",
      width: 90,
      render: (_: unknown, r: SessionRow) => (
        <Tag color={r.protocol === "anthropic" ? "purple" : "blue"}>
          {r.protocol === "anthropic" ? "Anthropic" : "OpenAI"}
        </Tag>
      ),
    },
    {
      title: "正在使用的模型",
      ellipsis: true,
      width: 200,
      render: (_: unknown, r: SessionRow) => (
        <Space direction="vertical" size={0}>
          <Typography.Text ellipsis style={{ maxWidth: 190 }}>
            {r.model || "—"}
          </Typography.Text>
          {r.modelRequested && r.modelRequested !== r.model && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              请求: {r.modelRequested}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: "实时速度",
      width: 110,
      align: "right",
      render: (_: unknown, r: SessionRow) =>
        r.speed != null ? (
          <Typography.Text strong type="success">
            {r.speed.toFixed(1)} tok/s
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: "并发",
      width: 70,
      align: "center",
      render: (_: unknown, r: SessionRow) =>
        r.activeRequests > 0 ? <Tag color="processing">{r.activeRequests}</Tag> : "0",
    },
    {
      title: "缓存命中率",
      width: 110,
      align: "center",
      render: (_: unknown, r: SessionRow) => (
        <CacheHitRate rate={r.cacheHitRate} read={r.cacheReadTokens} write={r.cacheCreationTokens} />
      ),
    },
    {
      title: "累计流量",
      width: 130,
      align: "right",
      render: (_: unknown, r: SessionRow) => (
        <Tooltip
          title={
            <div>
              <div>请求数：{r.requestCount}（错误 {r.errorCount}）</div>
              <div>输入：{fmtTokens(r.promptTokens)} tokens</div>
              <div>输出：{fmtTokens(r.completionTokens)} tokens</div>
              <div>累计成本：${r.cost.toFixed(4)}</div>
            </div>
          }
        >
          <Space direction="vertical" size={0} style={{ cursor: "help" }}>
            <span>{fmtTokens(r.totalTokens)} tok</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.requestCount} 次请求
            </Typography.Text>
          </Space>
        </Tooltip>
      ),
    },
    {
      title: "最近活动",
      dataIndex: "lastAt",
      width: 100,
      render: (v: number) => dayjs(v).format("HH:mm:ss"),
    },
    {
      title: "最近错误",
      ellipsis: true,
      width: 160,
      render: (_: unknown, r: SessionRow) =>
        r.lastError ? (
          <Tooltip title={r.lastError}>
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {r.lastError}
            </Typography.Text>
          </Tooltip>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={32}>
          <Col>
            <Statistic
              title={
                <span>
                  {snap.activeRequests > 0 && <Badge status="processing" />} 当前网关并发请求
                </span>
              }
              value={snap.activeRequests}
            />
          </Col>
          <Col>
            <Statistic title="活跃会话" value={snap.activeSessionCount} suffix={`/ ${snap.sessionCount}`} />
          </Col>
          <Col>
            <Statistic
              title="实时输出速度合计"
              value={totalSpeed > 0 ? totalSpeed.toFixed(1) : "—"}
              suffix={totalSpeed > 0 ? "tok/s" : ""}
            />
          </Col>
          <Col flex="auto">
            <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: 1.8 }}>
              说明：按网关会话 ID 聚合请求流量，实时速度为最近 10 秒的流式输出估算（约 3 字符 1 token），
              仅真流式透传时更新；缓存命中率 = 命中缓存输入 / 总输入。数据为内存态，服务重启后清零，
              空闲会话 30 分钟后从列表移除。
            </Typography.Text>
          </Col>
        </Row>
      </Card>

      <Table<SessionRow>
        rowKey="conversationId"
        size="middle"
        dataSource={snap.sessions}
        columns={columns}
        pagination={{ pageSize: 20, showSizeChanger: false, size: "small" }}
        locale={{
          emptyText: <Empty description="暂无请求流量，等待网关接入…" image={Empty.PRESENTED_IMAGE_SIMPLE} />,
        }}
        expandable={{
          rowExpandable: (r) => r.inFlight.length > 0,
          expandedRowRender: (r) => (
            <Table<InFlight>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={r.inFlight}
              columns={[
                { title: "请求 ID", dataIndex: "id", render: (v: string) => <Typography.Text copyable={{ text: v }}>{shortId(v)}</Typography.Text> },
                { title: "模型", dataIndex: "model", render: (v: string) => v || "—" },
                { title: "已进行", dataIndex: "elapsedMs", render: (v: number) => `${(v / 1000).toFixed(1)}s` },
                {
                  title: "状态",
                  dataIndex: "streaming",
                  render: (v: boolean) =>
                    v ? <Badge status="processing" text="流式输出中" /> : <Badge status="warning" text="处理中" />,
                },
              ]}
            />
          ),
        }}
      />
    </div>
  );
}
