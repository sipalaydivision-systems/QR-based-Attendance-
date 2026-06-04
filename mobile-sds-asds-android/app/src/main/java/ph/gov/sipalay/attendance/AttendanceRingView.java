package ph.gov.sipalay.attendance;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;

final class AttendanceRingView extends View {
    private final Paint track = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint arc = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint percentText = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint labelText = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF bounds = new RectF();
    private float animatedPercent = 0f;
    private int percent = 0;
    private int accentColor = Ui.GREEN_DARK;

    AttendanceRingView(Context context) {
        super(context);
        track.setStyle(Paint.Style.STROKE);
        track.setStrokeCap(Paint.Cap.ROUND);
        track.setColor(Color.rgb(205, 248, 229));

        arc.setStyle(Paint.Style.STROKE);
        arc.setStrokeCap(Paint.Cap.ROUND);
        arc.setColor(accentColor);

        percentText.setColor(Color.rgb(20, 24, 27));
        percentText.setTextAlign(Paint.Align.CENTER);
        percentText.setFakeBoldText(true);

        labelText.setColor(Color.rgb(83, 89, 96));
        labelText.setTextAlign(Paint.Align.CENTER);
        labelText.setFakeBoldText(true);
    }

    void setPercent(int value) {
        setPercent(value, accentColor);
    }

    void setPercent(int value, int color) {
        int next = Math.max(0, Math.min(100, value));
        accentColor = color;
        arc.setColor(accentColor);
        ValueAnimator animator = ValueAnimator.ofFloat(animatedPercent, next);
        animator.setDuration(550);
        animator.addUpdateListener(a -> {
            animatedPercent = (float) a.getAnimatedValue();
            invalidate();
        });
        percent = next;
        animator.start();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        int size = Math.min(getWidth(), getHeight());
        float stroke = size * 0.075f;
        track.setStrokeWidth(stroke);
        arc.setStrokeWidth(stroke);
        float pad = stroke + Ui.dp(getContext(), 8);
        bounds.set(pad, pad, getWidth() - pad, getHeight() - pad);
        canvas.drawArc(bounds, 0, 360, false, track);
        arc.setColor(accentColor);
        canvas.drawArc(bounds, -90, 360f * (animatedPercent / 100f), false, arc);

        percentText.setTextSize(size * 0.22f);
        labelText.setTextSize(size * 0.065f);
        canvas.drawText(percent + "%", getWidth() / 2f, getHeight() / 2f, percentText);
        canvas.drawText("ATTENDANCE", getWidth() / 2f, getHeight() / 2f + Ui.dp(getContext(), 22), labelText);
    }
}
