const ExcelJS = require('exceljs');
const path = require('path');

const schoolList = [
    'Agripino Alvarez Elementary School','Banag Elementary School','Barangay V Elementary School',
    'Barasbarasan Elementary School','Bawog Elementary School','Binotusan Elementary School',
    'Binulig Elementary School','Bungabunga Elementary School','Cabadiangan Elementary School',
    'Calangcang Elementary School','Calat-an Elementary School','Cambogui-ot Elementary School',
    'Cambogui-ot National High School','Camindangan Elementary School','Camindangan National High School',
    'Cansauro Elementary School','Cantaca Elementary School','Canturay Elementary School',
    'Cartagena Elementary School','Cayhagan Elementary School','Cayhagan National High School',
    'Crossing Tanduay Elementary School','Dung-i Integrated School','Dungga Integrated School',
    'Genaro P. Alvarez Elementary School','Genaro P. Alvarez Elementary School II',
    'Gil M. Montilla Elementary School','Gil Montilla National High School',
    'Hda. Maricalum Elementary School','Jacinto Montilla Memorial National High School',
    'Leodegario Ponce Gonzales National High School','Macarandan Integrated School',
    'Manlucahoc Elementary School','Mariano Gemora National High School',
    'Maricalum Elementary School','Maricalum Farm School','Mauboy Integrated School',
    'Nabulao Elementary School','Nabulao National High School','Nauhang Primary School',
    'Omas Integrated School','Patag Magbanua Elementary School','Sipalay City National High School',
    'Tugas Integrated School','Vista Alegre Integrated School'
];
const gradeList = ['1','2','3','4','5','6','7','8','9','10','11','12'];
const gradeElementary = ['1','2','3','4','5','6'];
const gradeHighSchool = ['7','8','9','10','11','12'];
const trackList = ['STEM','ABM','HUMSS','GAS','TVL-HE','TVL-ICT','TVL-IA','TVL-AFA','Sports','Arts & Design'];

const headerStyle = {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4834D4' } },
    alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    border: {
        top: { style: 'thin', color: { argb: 'FF3621B0' } },
        bottom: { style: 'thin', color: { argb: 'FF3621B0' } },
        left: { style: 'thin', color: { argb: 'FF3621B0' } },
        right: { style: 'thin', color: { argb: 'FF3621B0' } }
    }
};

function setHeaderCell(cell, title, subtitle) {
    cell.value = { richText: [
        { text: title + '\n', font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 } },
        { text: subtitle, font: { italic: true, color: { argb: 'FFFFFFFF' }, size: 9 } }
    ]};
    cell.fill = headerStyle.fill;
    cell.alignment = headerStyle.alignment;
    cell.border = headerStyle.border;
}

function addDropdowns(choicesSheet) {
    schoolList.forEach((name, idx) => { choicesSheet.getCell('A' + (idx + 1)).value = name; });
    gradeList.forEach((g, idx) => { choicesSheet.getCell('B' + (idx + 1)).value = g; });
    trackList.forEach((t, idx) => { choicesSheet.getCell('C' + (idx + 1)).value = t; });
    // Separate grade lists by school type
    const elemSchools = schoolList.filter(n => n.includes('Elementary') || n.includes('Primary'));
    const hsSchools = schoolList.filter(n => n.includes('National High School') || n.includes('Integrated') || n.includes('Farm School'));
    elemSchools.forEach((name, idx) => { choicesSheet.getCell('D' + (idx + 1)).value = name; });
    hsSchools.forEach((name, idx) => { choicesSheet.getCell('E' + (idx + 1)).value = name; });
    gradeElementary.forEach((g, idx) => { choicesSheet.getCell('F' + (idx + 1)).value = g; });
    gradeHighSchool.forEach((g, idx) => { choicesSheet.getCell('G' + (idx + 1)).value = g; });
}

function applyValidation(sheet, col, range, title, rows) {
    for (let r = 2; r <= rows; r++) {
        sheet.getCell(col + r).dataValidation = {
            type: 'list', allowBlank: true,
            formulae: [range],
            showInputMessage: true, promptTitle: title, prompt: 'Choose from the list'
        };
    }
}

async function generateStudent() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Template');
    const dd = workbook.addWorksheet('Dropdowns', { state: 'veryHidden' });
    addDropdowns(dd);

    sheet.columns = [{ width: 22 }, { width: 32 }, { width: 38 }, { width: 18 }, { width: 28 }, { width: 22 }];
    const row = sheet.getRow(1);
    setHeaderCell(row.getCell(1), 'LRN', '(e.g. 123456789012)');
    setHeaderCell(row.getCell(2), 'Student Name', '(Last Name, First Name, Middle Name)');
    setHeaderCell(row.getCell(3), 'School', '((Select from dropdown))');
    setHeaderCell(row.getCell(4), 'Grade', '((Select from dropdown))');
    setHeaderCell(row.getCell(5), 'Section', '(Capital first letter (e.g. Banana))');
    setHeaderCell(row.getCell(6), 'Guardian Contact', '(09XXXXXXXXX)');
    row.height = 40;

    applyValidation(sheet, 'C', 'Dropdowns!$A$1:$A$' + schoolList.length, 'Select School', 101);
    applyValidation(sheet, 'D', 'Dropdowns!$B$1:$B$' + gradeList.length, 'Select Grade', 101);

    await workbook.xlsx.writeFile(path.join(__dirname, 'public/templates/student_import_template.xlsx'));
    console.log('DONE: student_import_template.xlsx');
}

async function generateSHS() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Template');
    const dd = workbook.addWorksheet('Dropdowns', { state: 'veryHidden' });
    addDropdowns(dd);

    sheet.columns = [{ width: 22 }, { width: 32 }, { width: 38 }, { width: 18 }, { width: 24 }, { width: 28 }, { width: 22 }];
    const row = sheet.getRow(1);
    setHeaderCell(row.getCell(1), 'LRN', '(e.g. 123456789012)');
    setHeaderCell(row.getCell(2), 'Student Name', '(Last Name, First Name, Middle Name)');
    setHeaderCell(row.getCell(3), 'School', '((Select from dropdown))');
    setHeaderCell(row.getCell(4), 'Grade', '((Select from dropdown))');
    setHeaderCell(row.getCell(5), 'Track/Strand', '((Select from dropdown))');
    setHeaderCell(row.getCell(6), 'Section', '(Capital first letter (e.g. Banana))');
    setHeaderCell(row.getCell(7), 'Guardian Contact', '(09XXXXXXXXX)');
    row.height = 40;

    applyValidation(sheet, 'C', 'Dropdowns!$A$1:$A$' + schoolList.length, 'Select School', 101);
    applyValidation(sheet, 'D', 'Dropdowns!$B$1:$B$' + gradeList.length, 'Select Grade', 101);
    applyValidation(sheet, 'E', 'Dropdowns!$C$1:$C$' + trackList.length, 'Select Track', 101);

    await workbook.xlsx.writeFile(path.join(__dirname, 'public/templates/shs_student_import_template.xlsx'));
    console.log('DONE: shs_student_import_template.xlsx');
}

async function generateTeacher() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Template');
    const dd = workbook.addWorksheet('Dropdowns', { state: 'veryHidden' });
    addDropdowns(dd);

    sheet.columns = [{ width: 22 }, { width: 32 }, { width: 38 }, { width: 18 }, { width: 28 }, { width: 22 }];
    const row = sheet.getRow(1);
    setHeaderCell(row.getCell(1), 'Employee ID', '(e.g. EMP-001)');
    setHeaderCell(row.getCell(2), 'Name', '(Last Name, First Name, Middle Name)');
    setHeaderCell(row.getCell(3), 'School', '((Select from dropdown))');
    setHeaderCell(row.getCell(4), 'Grade', '((Select from dropdown))');
    setHeaderCell(row.getCell(5), 'Section', '(Capital first letter (e.g. Banana))');
    setHeaderCell(row.getCell(6), 'Contact Number', '(09XXXXXXXXX)');
    row.height = 40;

    applyValidation(sheet, 'C', 'Dropdowns!$A$1:$A$' + schoolList.length, 'Select School', 101);
    applyValidation(sheet, 'D', 'Dropdowns!$B$1:$B$' + gradeList.length, 'Select Grade', 101);

    await workbook.xlsx.writeFile(path.join(__dirname, 'public/templates/teacher_import_template.xlsx'));
    console.log('DONE: teacher_import_template.xlsx');
}

(async () => {
    await generateStudent();
    await generateSHS();
    await generateTeacher();
    console.log('ALL TEMPLATES GENERATED!');
})();
