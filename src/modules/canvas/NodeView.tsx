import { useEffect, useRef } from 'react';
import Konva from 'konva';
import {
  Arrow,
  Circle,
  Ellipse,
  Group,
  Image as KonvaImage,
  Line,
  Rect,
  Text as KonvaText,
} from 'react-konva';
import type {
  CanvasNode,
  CounterNode,
  FreehandNode,
  ImageNode,
  LineNode,
  OvalNode,
  RectNode,
  TextNode,
} from './types';
import { useImage } from './useImage';

export interface NodeViewProps {
  node: CanvasNode;
  baseImage: ImageNode | null;
  draggable: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onChange: (id: string, patch: Partial<CanvasNode>) => void;
  onDragStart: (id: string) => void;
  onDragMove: (id: string, patch: Partial<CanvasNode>) => void;
  onStartEdit: (id: string) => void;
  registerRef: (id: string, n: Konva.Node | null) => void;
}

/** Renders a blurred, clipped copy of the base screenshot inside a rect region.
 *  This is the real, non-destructive blur: a Gaussian-filtered copy of the
 *  underlying image shown only within the region the user dragged out. */
const BlurRegion = ({ node, baseImage }: { node: RectNode; baseImage: ImageNode | null }) => {
  const img = useImage(baseImage?.src);
  const ref = useRef<Konva.Image>(null);

  useEffect(() => {
    const k = ref.current;
    if (!k || !img) return;
    k.cache();
    k.getLayer()?.batchDraw();
  }, [img, node.style.blur, node.width, node.height, baseImage?.x, baseImage?.y]);

  if (!img || !baseImage) {
    // No base image to sample — fall back to a frosted panel so the region is
    // still visually obscuring.
    return (
      <Rect
        width={node.width}
        height={node.height}
        cornerRadius={4}
        fill="rgba(120,120,120,0.55)"
      />
    );
  }
  // The inner image is the full base image, offset so the region lines up with
  // what's beneath it; the Group clip crops it to the region.
  const scaleX = baseImage.width / img.naturalWidth;
  const scaleY = baseImage.height / img.naturalHeight;
  return (
    <Group clipX={0} clipY={0} clipWidth={node.width} clipHeight={node.height}>
      <KonvaImage
        ref={ref}
        image={img}
        x={baseImage.x - node.x}
        y={baseImage.y - node.y}
        scaleX={scaleX}
        scaleY={scaleY}
        filters={[Konva.Filters.Blur]}
        blurRadius={node.style.blur ?? 12}
      />
    </Group>
  );
};

export const NodeView = ({
  node,
  baseImage,
  draggable,
  onSelect,
  onChange,
  onDragStart,
  onDragMove,
  onStartEdit,
  registerRef,
}: NodeViewProps) => {
  const imgEl = useImage(node.tool === 'image' ? (node as ImageNode).src : undefined);

  // Konva positions an Ellipse by its centre; every other node by its top-left.
  // Map the dragged Konva position back to the node's stored top-left anchor.
  const dragPos = (e: Konva.KonvaEventObject<DragEvent>): Partial<CanvasNode> => {
    if (node.tool === 'oval') {
      const n = node as OvalNode;
      return { x: e.target.x() - n.width / 2, y: e.target.y() - n.height / 2 };
    }
    return { x: e.target.x(), y: e.target.y() };
  };

  const common = {
    ref: (n: Konva.Node | null) => registerRef(node.id, n),
    x: node.x,
    y: node.y,
    rotation: node.rotation,
    opacity: node.style.opacity,
    draggable,
    onClick: (e: Konva.KonvaEventObject<MouseEvent>) =>
      onSelect(node.id, e.evt.shiftKey),
    onTap: () => onSelect(node.id, false),
    onDragStart: () => onDragStart(node.id),
    onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => onDragMove(node.id, dragPos(e)),
    onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => onChange(node.id, dragPos(e)),
  };

  const dash = node.style.dashed ? [node.style.strokeWidth * 3, node.style.strokeWidth * 2] : undefined;

  switch (node.tool) {
    case 'image': {
      const n = node as ImageNode;
      return (
        <KonvaImage {...common} image={imgEl ?? undefined} width={n.width} height={n.height} />
      );
    }
    case 'rect':
    case 'erase': {
      const n = node as RectNode;
      const isErase = node.tool === 'erase';
      return (
        <Rect
          {...common}
          width={n.width}
          height={n.height}
          cornerRadius={n.style.radius ?? 0}
          stroke={isErase ? undefined : n.style.stroke}
          strokeWidth={isErase ? 0 : n.style.strokeWidth}
          dash={isErase ? undefined : dash}
          fill={isErase ? n.style.fill || '#ffffff' : n.style.fill}
        />
      );
    }
    case 'blur': {
      const n = node as RectNode;
      return (
        <Group {...common}>
          <BlurRegion node={n} baseImage={baseImage} />
        </Group>
      );
    }
    case 'highlighter': {
      const n = node as RectNode;
      return (
        <Rect
          {...common}
          width={n.width}
          height={n.height}
          fill={n.style.stroke}
          opacity={(node.style.opacity ?? 1) * 0.4}
          globalCompositeOperation="multiply"
          cornerRadius={2}
        />
      );
    }
    case 'oval': {
      const n = node as OvalNode;
      return (
        <Ellipse
          {...common}
          // Konva ellipse is centred; offset so (x,y) stays the top-left anchor.
          x={node.x + n.width / 2}
          y={node.y + n.height / 2}
          radiusX={n.width / 2}
          radiusY={n.height / 2}
          stroke={n.style.stroke}
          strokeWidth={n.style.strokeWidth}
          dash={dash}
          fill={n.style.fill === 'transparent' ? undefined : n.style.fill}
        />
      );
    }
    case 'line': {
      const n = node as LineNode;
      return (
        <Line
          {...common}
          points={n.points}
          stroke={n.style.stroke}
          strokeWidth={n.style.strokeWidth}
          dash={dash}
          lineCap="round"
          lineJoin="round"
          hitStrokeWidth={Math.max(12, n.style.strokeWidth + 8)}
        />
      );
    }
    case 'arrow': {
      const n = node as LineNode;
      return (
        <Arrow
          {...common}
          points={n.points}
          stroke={n.style.stroke}
          fill={n.style.stroke}
          strokeWidth={n.style.strokeWidth}
          dash={dash}
          pointerLength={Math.max(8, n.style.strokeWidth * 3)}
          pointerWidth={Math.max(8, n.style.strokeWidth * 3)}
          hitStrokeWidth={Math.max(12, n.style.strokeWidth + 8)}
        />
      );
    }
    case 'freehand': {
      const n = node as FreehandNode;
      return (
        <Line
          {...common}
          points={n.points}
          stroke={n.style.stroke}
          strokeWidth={n.style.strokeWidth}
          lineCap="round"
          lineJoin="round"
          tension={0.4}
          hitStrokeWidth={Math.max(12, n.style.strokeWidth + 8)}
        />
      );
    }
    case 'eraser': {
      // Real eraser: a stroke that punches transparency through everything
      // drawn beneath it in the layer (and so out of the exported PNG).
      const n = node as FreehandNode;
      return (
        <Line
          {...common}
          points={n.points}
          stroke="#000000"
          strokeWidth={n.style.strokeWidth}
          lineCap="round"
          lineJoin="round"
          tension={0.4}
          globalCompositeOperation="destination-out"
          hitStrokeWidth={Math.max(12, n.style.strokeWidth + 8)}
        />
      );
    }
    case 'text': {
      const n = node as TextNode;
      return (
        <KonvaText
          {...common}
          text={n.text || ' '}
          width={n.width || undefined}
          fontSize={n.style.fontSize ?? 24}
          fontFamily={n.style.fontFamily ?? 'Inter, system-ui, sans-serif'}
          fill={n.style.stroke}
          onDblClick={() => onStartEdit(node.id)}
          onDblTap={() => onStartEdit(node.id)}
        />
      );
    }
    case 'counter': {
      const n = node as CounterNode;
      return (
        <Group {...common}>
          <Circle
            radius={n.radius}
            x={n.radius}
            y={n.radius}
            fill={n.style.fill === 'transparent' ? n.style.stroke : n.style.fill}
            stroke={n.style.stroke}
            strokeWidth={2}
          />
          <KonvaText
            text={String(n.value)}
            x={0}
            y={n.radius - (n.style.fontSize ?? n.radius) / 2}
            width={n.radius * 2}
            align="center"
            fontSize={n.style.fontSize ?? Math.round(n.radius * 1.1)}
            fontStyle="bold"
            fontFamily="Inter, system-ui, sans-serif"
            fill="#ffffff"
            listening={false}
          />
        </Group>
      );
    }
    default:
      return null;
  }
};
