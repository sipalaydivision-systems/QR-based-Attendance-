package ph.gov.sipalay.attendance;

import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.content.Context;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

final class Ui {
    static final int INK = Color.rgb(15, 23, 42);
    static final int MUTED = Color.rgb(100, 116, 139);
    static final int PRIMARY = Color.rgb(79, 70, 229);
    static final int BG = Color.rgb(241, 245, 249);
    static final int CARD = Color.WHITE;
    static final int GREEN = Color.rgb(22, 163, 74);
    static final int RED = Color.rgb(220, 38, 38);
    static final int AMBER = Color.rgb(245, 158, 11);

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
}
