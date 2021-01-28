/**
 * The MIT License (MIT)
 *
 * Igor Zinken 2020-2021 - https://www.igorski.nl
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import Vue from "vue";
import { sprite } from "zcanvas"
import { createCanvas, canvasToBlob, resizeImage, globalToLocal } from "@/utils/canvas-util";
import { renderCross } from "@/utils/render-util";
import { blobToResource } from "@/utils/resource-manager";
import { LAYER_GRAPHIC, LAYER_MASK, LAYER_TEXT } from "@/definitions/layer-types";
import { getRectangleForSelection, isSelectionClosed } from "@/math/selection-math";
import { rotatePoints, translatePointerRotation } from "@/math/point-math";
import { renderEffectsForLayer } from "@/services/render-service";
import { clipContextToSelection } from "@/rendering/clipping";
import { renderClonedStroke } from "@/rendering/cloning";
import { renderBrushStroke } from "@/rendering/drawing";
import { flushLayerCache, clearCacheProperty } from "@/rendering/cache/bitmap-cache";
import {
    getTempCanvas, renderTempCanvas, disposeTempCanvas, slicePointers, createOverrideConfig
} from "@/rendering/lowres";
import BrushFactory from "@/factories/brush-factory";
import { getSpriteForLayer } from "@/factories/sprite-factory";
import { enqueueState } from "@/factories/history-state-factory";
import ToolTypes, { canDrawOnSelection } from "@/definitions/tool-types";

/**
 * A LayerSprite is the renderer for a Documents Layer.
 * It handles all tool interactions with the layer and also provides interaction with the Layers Mask.
 * It inherits from the zCanvas Sprite to be an interactive Canvas drawable.
 */
class LayerSprite extends sprite {
    constructor( layer ) {
        const { bitmap, x, y, width, height } = layer;
        super({ bitmap, x, y, width, height }); // zCanvas inheritance

        this.layer = layer; // the Layer this Sprite will be rendering

        if ([ LAYER_GRAPHIC, LAYER_TEXT ].includes( layer.type ) && !layer.source ) {
            // create a Canvas on which this layer will render its drawable content.
            const { cvs } = createCanvas( layer.width, layer.height );
            layer.source = cvs;
        }

        this._pointerX = 0;
        this._pointerY = 0;

        // brush properties (used for both drawing on LAYER_GRAPHIC types and to create layer masks)
        this._brush = BrushFactory.create();

        this.setActionTarget();

        if ( layer.source instanceof Image ) {
            const handler = () => {
                this.cacheEffects();
                layer.source.removeEventListener( "load", handler );
            }
            layer.source.addEventListener( "load", handler );
        }
        this.cacheEffects();
    }

    setActionTarget( target = "source" ) {
        this.actionTarget = target;
    }

    isDrawable() {
        return this.layer.type === LAYER_GRAPHIC || this.isMaskable();
    }

    isMaskable() {
        return !!this.layer.mask;
    }

    isRotated() {
        return ( this.layer.effects.rotation % 360 ) !== 0;
    }

    isScaled() {
        return this.layer.effects.scale !== 1;
    }

    cacheBrush( color = "rgba(255,0,0,1)", toolOptions = { radius: 5, strokes: 1 } ) {
        this._brush = BrushFactory.create({
            color,
            radius   : toolOptions.size,
            pointers : this._brush.pointers,
            options  : toolOptions
        });
    }

    storeBrushPointer( x, y ) {
        this._brush.down = true;
        this._brush.pointers.push({ x, y });
    }

    cacheEffects() {
        if ( this._rafFx ) {
            return; // debounced to only occur once before next render cycle
        }
        this._rafFx = true;
        requestAnimationFrame( async () => {
            await renderEffectsForLayer( this.layer );
            this._rafFx = false;
        });
    }

    resetFilterAndRecache() {
        clearCacheProperty( this.layer, "filterData" ); // filter must be applied to new contents
        this.cacheEffects(); // sync mask and source changes with sprite Bitmap
    }

    getBitmap() {
        return this._bitmap;
    }

    handleActiveLayer({ id }) {
        this.setInteractive( this.layer.id === id );
    }

    setSelection( selection ) {
        if ( isSelectionClosed( selection ) && canDrawOnSelection( this.layer )) {
            this._selection = selection;
        }
    }

    resetSelection() {
        this._selection = null;
    }

    handleActiveTool( tool, toolOptions, activeDocument ) {
        this.isDragging        = false;
        this._isPaintMode      = false;
        this._isDragMode       = false;
        this._isColorPicker    = false;
        this._selection        = null;
        this._toolType         = null;
        this._toolOptions      = null;
        this._cloneStartCoords = null;

        // store pending paint states (if there were any)
        this.storePaintState();

        if ( !this._interactive || !tool ) {
            return;
        }

        this._toolType    = tool;
        this._toolOptions = toolOptions;

        // note we use setDraggable() even outside of ToolTypes.DRAG
        // this is because draggable zCanvas.sprites will trigger the handleMove()
        // handler on pointer events. We override handleMove() for tool specific behaviour.

        switch ( tool ) {
            default:
                this.setDraggable( false );
                break;
            case ToolTypes.DRAG:
                this._isDragMode = true;
                this.setDraggable( true );
                break;
            // drawables
            case ToolTypes.FILL:
            case ToolTypes.ERASER:
            case ToolTypes.BRUSH:
            case ToolTypes.CLONE:
                this.forceMoveListener();
                this.setDraggable( true );
                this._isPaintMode = true;
                this.cacheBrush( this.canvas.store.getters.activeColor, toolOptions );

                // drawable tools can work alongside an existing selection
                this.setSelection( activeDocument.selection );
                break;
            case ToolTypes.EYEDROPPER:
                this._isColorPicker = true;
                break;
        }
        this.invalidate();
    }

    // cheap way to hook into zCanvas.handleMove()-handler so we can keep following the cursor in tool modes
    forceMoveListener() {
        this.isDragging       = true;
        this._dragStartOffset = { x: this.getX(), y: this.getY() };
        this._dragStartEventCoordinates = { x: this._pointerX, y: this._pointerY };
    }

    // draw onto the source Bitmap (e.g. brushing / fill tool / eraser)

    paint() {
        if ( !this._pendingPaintState ) {
            this.preparePendingPaintState();
        }
        const { left, top } = this._bounds;
        const { mirrorX, mirrorY, rotation } = this.layer.effects;

        const drawOnMask   = this.isMaskable();
        const isEraser     = this._toolType === ToolTypes.ERASER;
        const isCloneStamp = this._toolType === ToolTypes.CLONE;
        const isFillMode   = this._toolType === ToolTypes.FILL;

        // get the drawing context
        let ctx = ( drawOnMask ? this.layer.mask : this.layer.source ).getContext( "2d" );
        const { width, height } = ctx.canvas;

        ctx.save();

        if ( isEraser ) {
            ctx.globalCompositeOperation = "destination-out";
        }

        // if there is an active selection, painting will be constrained within
        let selectionPoints = this._selection;
        let sX, sY;
        if ( selectionPoints ) {
            const rotCenterX = this._bounds.width  * 0.5;
            const rotCenterY = this._bounds.height * 0.5;
            sX = left;
            sY = top;
            if ( this.isRotated() ) {
                selectionPoints = rotatePoints( selectionPoints, rotCenterX, rotCenterY, rotation );
                const rect = getRectangleForSelection( selectionPoints );
                // TODO: 0, 0 coordinate is fine when layer isn't panned...
                //const pts = translatePointerRotation( 0, 0, rect.width / 2, rect.height / 2, rotation );
                //console.warn(pts);
                sX = 0;//pts.x;
                sY = 0;//pts.y;
            }
            clipContextToSelection( ctx, selectionPoints, isFillMode, sX, sY );
        }

        // transform destination context in case the current layer is rotated or mirrored
        ctx.scale( mirrorX ? -1 : 1, mirrorY ? -1 : 1 );

        if ( isFillMode )
        {
            ctx.fillStyle = this.canvas?.store.getters.activeColor;
            if ( this._selection ) {
                ctx.fill();
                ctx.closePath(); // is this necessary ?
            } else {
                ctx.fillRect( 0, 0, width, height );
            }
        }
        else {
            // get the enqueued pointers which are to be rendered in this paint cycle
            const pointers = slicePointers( this._brush );

            if ( isCloneStamp ) {
                if ( this._brush.down ) {
                    renderClonedStroke( ctx, this._brush, this, this._toolOptions.sourceLayerId,
                        rotatePointerLists( pointers, this.layer, width, height )
                    );
                    // clone operation is direct-to-Layer-source
                    this.setBitmap( ctx.canvas );
                }
            } else {
                // brush operations are done on a lower resolution canvas during live update
                // upon release, this will be rendered to the Layer source (see handleRelease())
                let overrides = null;
                if ( this._brush.down ) {
                    // live update on lower resolution canvas
                    this.tempCanvas = this.tempCanvas || getTempCanvas( this.canvas );
                    overrides = createOverrideConfig( this.canvas, pointers );
                    ctx.restore(); // restore previous context before switching to lowres context
                    ctx = this.tempCanvas.ctx;

                    if ( selectionPoints && this.tempCanvas ) {
                        clipContextToSelection( ctx, selectionPoints, isFillMode, sX - left, sY - top, overrides );
                    }
                } else {
                    rotatePointerLists( this._brush.pointers, this.layer, width, height );
                }
                renderBrushStroke( ctx, this._brush, this, overrides );
            }
        }
        ctx.restore();

        // when brushing, defer recache of filters to handleRelease()
        if ( !this._brush.down ) {
            this.resetFilterAndRecache();
        }
    }

    /**
     * As storing Bitmaps will consume a lot of memory fast we debounce this by
     * a larger interval to prevent creating a big bitmap per brush stroke.
     * Note that upon switching tools the state is enqueued immediately to
     * not delay to history state UI from updating more than necessary.
     */
    preparePendingPaintState() {
        canvasToBlob( this.layer.source ).then( blob => {
            this._orgSourceToStore = blobToResource( blob );
        });
        this.debouncePaintStore();
    }

    debouncePaintStore( timeout = 5000 ) {
        this._pendingPaintState = setTimeout( this.storePaintState.bind( this ), timeout );
    }

    storePaintState() {
        if ( !this._pendingPaintState ) {
            return true;
        }
        clearTimeout( this._pendingPaintState );
        if ( this._brush.down ) {
            // still painting, debounce again (layer.source only updated on handleRelease())
            this.debouncePaintStore( 1000 );
            return false;
        }
        this._pendingPaintState = null;
        const layer    = this.layer;
        const orgState = this._orgSourceToStore;

        this._orgSourceToStore = null;

        return canvasToBlob( layer.source ).then( blob => {
            const newState = blobToResource( blob );
            enqueueState( `spritePaint_${layer.id}`, {
                undo() {
                    restorePaintFromHistory( layer, orgState );
                },
                redo() {
                    restorePaintFromHistory( layer, newState);
                },
                resources: [ orgState, newState ],
            });
            return true;
        });
    }

    /* the following override zCanvas.sprite */

    setBounds( x, y, width = 0, height = 0 ) {
        const bounds = this._bounds;
        const layer  = this.layer;

        // store current values (for undo)
        const { left, top } = bounds;
        const oldLayerX = layer.x;
        const oldLayerY = layer.y;

        if ( width === 0 || height === 0 ) {
            ({ width, height } = bounds );
        }

        // commit change
        super.setBounds( x, y, width, height );

        // store new value (for redo)
        const newX = bounds.left;
        const newY = bounds.top;

        // update the Layer model by the relative offset
        // (because the Sprite has an alternate position when rotated)

        const newLayerX = layer.x + ( newX - left );
        const newLayerY = layer.y + ( newY - top );

        layer.x = newLayerX;
        layer.y = newLayerY;

        enqueueState( `spritePos_${layer.id}`, {
            undo() {
                positionSpriteFromHistory( layer, left, top );
                layer.x = oldLayerX;
                layer.y = oldLayerY;
            },
            redo() {
                positionSpriteFromHistory( layer, newX, newY );
                layer.x = newLayerX;
                layer.y = newLayerY;
            }
        });
        this.invalidate();
    }

    handlePress( x, y, { type }) {
        if ( type.startsWith( "touch" )) {
            this._pointerX = x;
            this._pointerY = y;
        }
        if ( this._isColorPicker ) {
            // color picker mode, get the color below the clicked point
            const local = globalToLocal( this.canvas, x, y );
            const p = this.canvas.getElement().getContext( "2d" ).getImageData(
                local.x - this.canvas._viewport.left,
                local.y - this.canvas._viewport.top,
                1, 1
            ).data;
            this.canvas.store.commit( "setActiveColor", `rgba(${p[0]},${p[1]},${p[2]},${(p[3]/255)})` );
        }
        else if ( this._isPaintMode ) {
            if ( this._toolType === ToolTypes.CLONE ) {
                // pressing down when using the clone tool with no coords defined in the _toolOptions,
                // sets the source coords (within the source Layer)
                if ( !this._toolOptions.coords ) {
                    this._toolOptions.coords = { x, y };
                    return;
                } else if ( !this._cloneStartCoords ) {
                    // pressing down again indicates the cloning paint operation starts (in handleMove())
                    // set the start coordinates (of this target Layer) relative to the source Layers coords
                    this._cloneStartCoords = { x, y };
                }
            } else if ( this._toolType === ToolTypes.FILL ) {
                this.paint();
                return;
            }
            // for any other brush mode state, set the brush application to true (will be applied in handleMove())
            this.storeBrushPointer( x, y );
        }
    }

    handleMove( x, y, { type }) {
        // store reference to current pointer position (relative to canvas)
        // note that for touch events this is handled in handlePress() instead
        if ( !type.startsWith( "touch" )) {
            this._pointerX = x;
            this._pointerY = y;
        }

        let recacheEffects = false;

        if ( !this._isPaintMode ) {
            // not drawable, perform default behaviour (drag)
            if ( this.actionTarget === "mask" ) {
                this.layer.maskX = this._dragStartOffset.x + (( x - this._bounds.left ) - this._dragStartEventCoordinates.x );
                this.layer.maskY = this._dragStartOffset.y + (( y - this._bounds.top )  - this._dragStartEventCoordinates.y );
                this.resetFilterAndRecache();
            } else if ( this._isDragMode ) {
                super.handleMove( x, y );
                return;
            }
        }

        // brush mode and brushing is active
        if ( this._brush.down ) {
            // enqueue current pointer position, painting of all enqueued pointers will be deferred
            // to the update()-hook, this prevents multiple renders on each move event
            this.storeBrushPointer( x, y );
        }
    }

    handleRelease( x, y ) {
        if ( this._brush.down ) {
            // brushing was active, deactivate brushing and render the
            // high resolution version of the brushed path onto the Layer source
            disposeTempCanvas();
            this.tempCanvas  = null;
            this._brush.down = false;
            this._brush.last = 0;
            this.paint();
            this._brush.pointers = []; // pointers have been rendered, reset
            // immediately store pending history state when not running in lowMemory mode
            if ( !this.canvas.store.getters.getPreference( "lowMemory" )) {
                this.storePaintState();
            }
        }
        if ( this._isPaintMode ) {
            this.forceMoveListener(); // keeps the move listener active
        }
    }

    update() {
        if ( this._brush.down ) {
            this.paint();
            this._brush.last = this._brush.pointers.length;
        }
    }

    draw( documentContext, viewport, omitOutlines = false ) {
        const scaleDocument = this.isScaled();

        // in case Layer has scale effect, apply it here (we don't resample the
        // actual Layer source to make this behaviour non-destructive, it's
        // merely a visualization and thus renderer affair)

        if ( scaleDocument ) {
            const { scale } = this.layer.effects;
            const { left, top, width, height } = this._bounds;
            const xTranslation = ( left + width  * 0.5 ) - viewport.left;
            const yTranslation = ( top  + height * 0.5 ) - viewport.top;
            documentContext.save();
            documentContext.translate( xTranslation, yTranslation );
            documentContext.scale( scale, scale );
            documentContext.translate( -xTranslation, -yTranslation );
        }
        // invoke base class behaviour to render bitmap
        super.draw( documentContext, viewport );

        // sprite is currently brushing, render low resolution temp contents onto screen
        if ( this.tempCanvas ) {
            documentContext.save();
            if ( this._toolType === ToolTypes.ERASER ) {
                documentContext.globalCompositeOperation = "destination-out";
            }
            renderTempCanvas( this.canvas, documentContext );
            documentContext.restore();
        }

        if ( !omitOutlines ) {

            const { zoomFactor } = this.canvas;

            // render brush outline at pointer position

            if ( this._isPaintMode ) {
                documentContext.lineWidth = 2 / zoomFactor;
                const drawBrushOutline = this._toolType !== ToolTypes.CLONE || !!this._toolOptions.coords;
                if ( this._toolType === ToolTypes.CLONE ) {
                    const { coords } = this._toolOptions;
                    let tx = this._pointerX - viewport.left;
                    let ty = this._pointerY - viewport.top;
                    const relSource = this._cloneStartCoords ?? this._dragStartEventCoordinates;
                    if ( coords ) {
                        tx = ( coords.x - viewport.left ) + ( this._pointerX - relSource.x );
                        ty = ( coords.y - viewport.top  ) + ( this._pointerY - relSource.y );
                    }
                    // when no source coordinate is set, or when applying the clone stamp, we show a cross to mark the origin
                    if ( !coords || this._brush.down ) {
                        renderCross( documentContext, tx, ty, this._brush.radius / zoomFactor );
                    }
                }
                documentContext.save();
                documentContext.beginPath();

                if ( drawBrushOutline ) {
                    // any other brush mode state shows brush outline
                    documentContext.arc( this._pointerX - viewport.left, this._pointerY - viewport.top, this._brush.radius, 0, 2 * Math.PI );
                    documentContext.strokeStyle = "#999";
                }
                documentContext.stroke();
                documentContext.restore();
            }

            // interactive state implies the sprite's Layer is currently active
            // show a border around the Layer contents to indicate the active area

            if ( this._interactive ) {
                documentContext.save();
                documentContext.lineWidth   = 1 / zoomFactor;
                documentContext.strokeStyle = "#0db0bc";
                const { x, y, width, height } = this.layer;
                const destX = x - viewport.left;
                const destY = y - viewport.top;
                if ( this.isRotated()) {
                    const tX = destX + ( width  * .5 );
                    const tY = destY + ( height * .5 );
                    documentContext.translate( tX, tY );
                    documentContext.rotate( this.layer.effects.rotation );
                    documentContext.translate( -tX, -tY );
                }
                documentContext.strokeRect( destX, destY, width, height );
                documentContext.restore();
            }
        }

        if ( scaleDocument ) {
            documentContext.restore();
        }
    }

    dispose() {
        super.dispose();

        flushLayerCache( this.layer );

        this._bitmap      = null;
        this._bitmapReady = false;
    }
}
export default LayerSprite;

/* internal non-instance methods */

function rotatePointerLists( pointers, layer, sourceWidth, sourceHeight ) {
    // we take layer.x instead of bounds.left as it provides the unrotated Layer offset
    const { x, y } = layer;
    // translate pointer to translated space, when layer is rotated or mirrored
    const { mirrorX, mirrorY, rotation } = layer.effects;
    pointers.forEach( point => {
        // translate recorded pointer towards rotated point
        // and against layer position
        const p = translatePointerRotation( point.x - x, point.y - y, sourceWidth * 0.5, sourceHeight * 0.5, rotation );
        if ( mirrorX ) {
            p.x -= sourceWidth;
        }
        if ( mirrorY ) {
            p.y -= sourceHeight;
        }
        point.x = p.x;
        point.y = p.y;
    });
    return pointers;
}

// NOTE we use getSpriteForLayer() instead of passing the Sprite by reference
// as it is possible the Sprite originally rendering the Layer has been disposed
// and a new one has been created while traversing the change history

function positionSpriteFromHistory( layer, x, y ) {
    const sprite = getSpriteForLayer( layer );
    if ( sprite ) {
        sprite._bounds.left = x;
        sprite._bounds.top  = y;
        sprite.invalidate();
    }
}

function restorePaintFromHistory( layer, state ) {
    const ctx = layer.source.getContext( "2d" );
    ctx.clearRect( 0, 0, layer.source.width, layer.source.height );
    const image  = new Image();
    image.onload = () => {
        ctx.drawImage( image, 0, 0 );
        getSpriteForLayer( layer )?.resetFilterAndRecache();
    };
    image.src = state;
}
