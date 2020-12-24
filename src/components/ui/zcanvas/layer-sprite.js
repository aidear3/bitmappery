/**
 * The MIT License (MIT)
 *
 * Igor Zinken 2020 - https://www.igorski.nl
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
import { sprite } from "zcanvas";
import { createCanvas, resizeImage, globalToLocal } from "@/utils/canvas-util";
import { LAYER_GRAPHIC, LAYER_MASK } from "@/definitions/layer-types";
import { isPointInRange, translatePointerRotation, getRotationCenter } from "@/utils/image-math";
import ToolTypes from "@/definitions/tool-types";

/**
 * A LayerSprite is the renderer for a Documents Layer.
 * It handles all tool interactions with the layer and also provides interaction with the Layers Mask.
 * It inherits from the zCanvas Sprite to be an interactive Canvas drawable.
 */
class LayerSprite extends sprite {
    constructor( layer ) {
        if ( layer.type === LAYER_GRAPHIC && !layer.bitmap ) {
            // create a Bitmap on which this layer will render its drawable content.
            // assign this Bitmap to the layer
            const { cvs } = createCanvas( layer.width, layer.height );
            layer.bitmap = cvs;
        }
        let { bitmap, x, y, width, height } = layer;

        // zCanvas inheritance
        super({ bitmap, x, y, width, height } );

        // Layer this sprite is rendering
        this.layer = layer;

        // create brush (always as all layers can be maskable)
        const brushCanvas = createCanvas();
        this._brushCvs    = brushCanvas.cvs;
        this._brushCtx    = brushCanvas.ctx;
        this._halfRadius  = 0;
        this._pointerX    = 0;
        this._pointerY    = 0;

        this.cacheBrush( this.canvas?.store.getters.activeColor || "rgba(255,0,0,1)" );
        this.cacheMask();
        this.setActionTarget();
    }

    setActionTarget( target = "bitmap" ) {
        this.actionTarget = target;
    }

    isDrawable() {
        return this.layer.type === LAYER_GRAPHIC || this.isMaskable();
    }

    isMaskable() {
        return !!this.layer.mask;
    }

    cacheBrush( color, radius = 30 ) {
        this._radius = radius;

        const innerRadius = radius / 10;
        const outerRadius = radius * 2;

        const x = radius;
        const y = radius;

        // update brush Canvas size
        this._brushCvs.width  = outerRadius;
        this._brushCvs.height = outerRadius;

        if ( !this._brushCtx ) {
            return; // TODO: this is because in Jenkins on Linux there is no canvas mock available
        }

        const gradient = this._brushCtx.createRadialGradient( x, y, innerRadius, x, y, outerRadius );
        gradient.addColorStop( 0, color );

        let color2 = "rgba(255,255,255,0)";
/*
        if ( color.startsWith( "rgba" )) {
            const [r, g, b, a] = color.split( "," );
            color2 = `${r},${g},${b},0)`;
        }
*/
        gradient.addColorStop( 1, color2 );

        this._brushCtx.clearRect( 0, 0, this._brushCvs.width, this._brushCvs.height );
        this._brushCtx.arc( x, y, radius, 0, 2 * Math.PI );
        this._brushCtx.fillStyle = gradient;
        this._brushCtx.fill();

        this._halfRadius = radius / 2;
    }

    cacheMask() {
        if ( !!this.layer.mask  ) {
            this._maskCanvas = createCanvas( this.layer.width, this.layer.height ).cvs;
            this._cacheMask  = true; // requests initial rendering of masked content
        } else {
            this._maskCanvas = null;
        }
    }

    handleActiveTool( tool, activeLayer ) {
        this.setInteractive( this.layer === activeLayer );
        this.isDragging   = false;
        this._isBrushMode = false;

        if ( !this._interactive ) {
            return;
        }
        this._isBrushMode   = false;
        this._isSelectMode  = false;
        this._isColorPicker = false;

        switch ( tool ) {
            default:
                this.setDraggable( false );
                break;
            case ToolTypes.MOVE:
                this.setDraggable( true );
                break;
            case ToolTypes.ERASER:
            case ToolTypes.BRUSH:
                this.forceDrag();
                this.setDraggable( true );
                this._isBrushMode = true;
                this._brushType   = tool;
                break;
            case ToolTypes.LASSO:
                this.forceDrag();
                this.setDraggable( true );
                this._isSelectMode = true;
                break;
            case ToolTypes.EYEDROPPER:
                this._isColorPicker = true;
                break;
        }
        this.resetSelection();
    }

    resetSelection() {
        if ( this._isSelectMode ) {
            Vue.set( this.layer, "selection", [] );
        } else {
            Vue.delete( this.layer, "selection" );
        }
        this._selectionClosed = false;
    }

    async resize( width, height ) {
        const ratioX = width  / this._bounds.width;
        const ratioY = height / this._bounds.height;

        if ( this.layer.bitmap ) {
            this.layer.bitmap = await resizeImage(
                this.layer.bitmap, this._bounds.width, this._bounds.height, width, height
            );
        }
        if ( this.layer.mask ) {
            this.layer.mask = await resizeImage(
                this.layer.mask, this._bounds.width, this._bounds.height, width, height
            );
            this.cacheMask();
        }
        this.setBounds( this.getX() * ratioX, this.getY() * ratioY, width, height );
        this.invalidate();
    }

    // cheap way to hook into zCanvas.handleMove()-handler to keep following the cursor in draw()
    forceDrag() {
        this.isDragging       = true;
        this._dragStartOffset = { x: this.getX(), y: this.getY() };
        this._dragStartEventCoordinates = { x: this._pointerX, y: this._pointerY };
    }

    /* the following override zCanvas.sprite */

    handleMove( x, y ) {
        // store reference to current pointer position
        this._pointerX = x;
        this._pointerY = y;

        // for rotated content we must translate the pointer coordinates to the unrotated position
        if ( this.layer.rotation ) {
            // TODO: this is going all sorts of wrong.
            const { tX, tY } = getRotationCenter( this._bounds );
            ({ x, y } = translatePointerRotation( x, y, tX, tY, this.layer.rotation ));
        }

        if ( !this._isBrushMode ) {
            // not drawable, perform default behaviour (drag)
            if ( this.actionTarget === "mask" ) {
                this.layer.maskX = this._dragStartOffset.x + ( x - this._dragStartEventCoordinates.x );
                this.layer.maskY = this._dragStartOffset.y + ( y - this._dragStartEventCoordinates.y );
                this._cacheMask  = true;
            } else if ( !this._isSelectMode ) {
                this.layer.x = x;
                this.layer.y = y;
                return super.handleMove( x, y );
            }
        }
        // brush tool active (either draws/erasers onto IMAGE_GRAPHIC layer bitmap
        // or on the mask bitmap)
        if ( this._applyBrush ) {
            const drawOnMask = this.isMaskable();
            const isEraser   = this._brushType === ToolTypes.ERASER;
            // get the drawing context
            const ctx = drawOnMask ? this.layer.mask.getContext( "2d" ) : this._bitmap.getContext( "2d" );
            if ( isEraser ) {
                ctx.save();
                ctx.globalCompositeOperation = "destination-out";
            }
            // note we draw directly onto the layer bitmaps, making this permanent
            ctx.drawImage( this._brushCvs, ( x - this.getX() ) - this._radius, y - this.getY() - this._radius );
            if ( isEraser ) {
                ctx.restore();
            }
            // invalidate cached mask canvas contents (draw() method will render these)
            if ( drawOnMask ) {
                this._cacheMask = true;
            }
        }
    }

    handlePress( x, y ) {
        if ( this._isColorPicker ) {
            const local = globalToLocal( this.canvas, x, y );
            const p = this.canvas.getElement().getContext( "2d" ).getImageData( local.x, local.y, 1, 1 ).data;
            this.canvas.store.commit( "setActiveColor", `rgba(${p[0]},${p[1]},${p[2]},${(p[3]/255)})` );
        } else if ( this._isBrushMode ) {
            this._applyBrush = true;
        } else if ( this._isSelectMode && !this._selectionClosed ) {
            const firstPoint = this.layer.selection[ 0 ];
            if ( firstPoint && isPointInRange( x, y, firstPoint.x, firstPoint.y )) {
                this._selectionClosed = true;
            }
            this.layer.selection.push({ x, y });
        }
    }

    handleRelease( x, y ) {
        this._applyBrush = false;
        if ( this._isBrushMode || this._isSelectMode ) {
            this.forceDrag();
        }
    }

    invalidate() {
        this._cacheMask = true;
        super.invalidate();
    }

    draw( documentContext ) {
        if ( this.layer.rotation ) {
            documentContext.save();
            const { tX, tY } = getRotationCenter( this._bounds );
            documentContext.translate( tX, tY );
            documentContext.rotate( this.layer.rotation );
            documentContext.translate( -tX, -tY );
        }
        if ( !this.isMaskable() ) {
            // use base draw() logic when no mask is set
            super.draw( documentContext );
        } else if ( this._maskCanvas ) {
            const { left, top, width, height } = this._bounds;
            // render masked contents into mask canvas
            if ( this._cacheMask ) {
                const ctx = this._maskCanvas.getContext( "2d" );
                ctx.save();
                ctx.drawImage( this.layer.bitmap, 0, 0 );
                ctx.globalCompositeOperation = "destination-in";
                ctx.drawImage( this.layer.mask, this.layer.maskX, this.layer.maskY );
                ctx.restore();
                this._cacheMask = false;
            }
            // render cached mask canvas onto document context
            documentContext.drawImage(
                this._maskCanvas,
                ( .5 + left )   << 0,
                ( .5 + top  )   << 0,
                ( .5 + width )  << 0,
                ( .5 + height ) << 0
            );
        }
        if ( this.layer.rotation ) {
            documentContext.restore();
        }
        // render brush outline at pointer position
        if ( this._isBrushMode ) {
            documentContext.save();
            documentContext.beginPath();
            documentContext.arc( this._pointerX, this._pointerY, this._radius, 0, 2 * Math.PI );
            documentContext.stroke();
            documentContext.restore();
        }
        // render selection outline
        if ( this._isSelectMode ) {
            documentContext.save();
            documentContext.beginPath();
            documentContext.lineWidth = 2 / this.canvas.zoomFactor;
            this.layer.selection.forEach(( point, index ) => {
                documentContext[ index === 0 ? "moveTo" : "lineTo" ]( point.x, point.y );
            });
            // draw line to current cursor position
            if ( !this._selectionClosed ) {
                documentContext.lineTo( this._pointerX, this._pointerY );
            }
            documentContext.stroke();
            // highlight current cursor position
            if ( !this._selectionClosed ) {
                documentContext.beginPath();
                documentContext.lineWidth *= 1.5;
                const firstPoint = this.layer.selection[ 0 ];
                const size = firstPoint && isPointInRange( this._pointerX, this._pointerY, firstPoint.x, firstPoint.y ) ? 15 : 5;
                documentContext.arc( this._pointerX, this._pointerY, size / this.canvas.zoomFactor, 0, 2 * Math.PI );
                documentContext.stroke();
            }
            documentContext.restore();
        }
    }
}
export default LayerSprite;