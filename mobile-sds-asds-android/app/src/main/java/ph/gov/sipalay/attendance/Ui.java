package ph.gov.sipalay.attendance;

import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.content.Context;
import android.view.animation.DecelerateInterpolator;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

final class Ui {
    static final int INK = Color.rgb(15, 23, 42);
    static final int MUTED = Color.rgb(133, 111, 137);
    static final int PRIMARY = Color.rgb(255, 116, 24);
    static final int PRIMARY_DARK = Color.rgb(231, 87, 12);
    static final int PLUM = Color.rgb(91, 42, 91);
    static final int PLUM_SOFT = Color.rgb(246, 238, 248);
    static final int BG = Color.rgb(237, 240, 250);
    static final int CARD = Color.WHITE;
    static final int GREEN = Color.rgb(22, 163, 74);
    static final int RED = Color.rgb(220, 38, 38);
    static final int AMBER = Color.rgb(255, 116, 24);
    static final int LINE = Color.rgb(230, 220, 232);

    private Ui() {}

    static GradientDrawable bg(int color, float radius) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(radius);
        return d;
    }

    static GradientDrawable strokeBg(int color, int strokeColor, float radius) {
        GradientDrawable d = bg(color, radius);
        d.setStroke(2, strokeColor);
        return d;
    }

    static GradientDrawable gradient(int start, int end, float radius) {
        GradientDrawable d = new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, new int[]{start, end});
        d.setCornerRadius(radius);
        return d;
    }

    static GradientDrawable verticalGradient(int start, int end, float radius) {
        GradientDrawable d = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{start, end});
        d.setCornerRadius(radius);
        return d;
    }

    static TextView text(Context context, String value, int size, int color, int style) {
        TextView t = new TextView(context);
        t.setText(value);
        t.setTextSize(size);
        t.setTextColor(color);
        t.setTypeface(Typeface.DEFAULT, style);
        t.setIncludeFontPadding(true);
        return t;
    }

    static LinearLayout.LayoutParams lp(int width, int height) {
        return new LinearLayout.LayoutParams(width, height);
    }

    static LinearLayout.LayoutParams marginLp(int width, int height, int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams lp = lp(width, height);
        lp.setMargins(left, top, right, bottom);
        return lp;
    }

    static void elevate(View view, float value) {
        view.setElevation(value);
    }

    static void reveal(View view, long delayMs) {
        view.setAlpha(0f);
        view.setTranslationY(28f);
        view.animate()
                .alpha(1f)
                .translationY(0f)
                .setStartDelay(delayMs)
                .setDuration(420)
                .setInterpolator(new DecelerateInterpolator())
                .start();
    }

    static void pulse(View view) {
        view.animate()
                .scaleX(1.04f)
                .scaleY(1.04f)
                .setDuration(420)
                .withEndAction(() -> view.animate().scaleX(1f).scaleY(1f).setDuration(420).start())
                .start();
    }
}
