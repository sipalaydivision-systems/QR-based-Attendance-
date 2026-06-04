package ph.gov.sipalay.attendance;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;
import android.view.animation.DecelerateInterpolator;

final class AttendanceProgressView extends View {
    private final Paint track = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF rect = new RectF();
    private float animatedPercent = 0f;
    private int accentColor = Ui.GREEN_DARK;

    AttendanceProgressView(Context context) {
        super(context);
        track.setColor(Color.rgb(224, 237, 232));
        fill.setColor(accentColor);
    }

    void setPercent(int value, int color) {
        int next = Math.max(0, Math.min(100, value));
        accentColor = color;
        fill.setColor(accentColor);
        ValueAnimator animator = ValueAnimator.ofFloat(animatedPercent, next);
        animator.setDuration(520);
        animator.setInterpolator(new DecelerateInterpolator());
        animator.addUpdateListener(a -> {
            animatedPercent = (float) a.getAnimatedValue();
            invalidate();
        });
        animator.start();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float radius = getHeight() / 2f;
        rect.set(0, 0, getWidth(), getHeight());
        canvas.drawRoundRect(rect, radius, radius, track);
        float fillWidth = getWidth() * (animatedPercent / 100f);
        if (fillWidth > 0f) {
            rect.set(0, 0, Math.max(fillWidth, getHeight()), getHeight());
            fill.setColor(accentColor);
            canvas.drawRoundRect(rect, radius, radius, fill);
        }
    }
}
